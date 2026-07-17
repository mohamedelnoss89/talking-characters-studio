/**
 * Wav2Lip API Client
 *
 * IMPORTANT — ARCHITECTURE CHANGE
 * --------------------------------
 * Previously this client called Next.js API routes (`/api/tts`, `/api/lip-sync`, …)
 * which were serverless proxies running on Vercel that forwarded each request to
 * `http://localhost:8000`. That worked in dev (because the user's machine was
 * "the server") but in production on Vercel, `localhost:8000` meant *Vercel's
 * own machine*, which has no Python backend → every request failed with 503.
 *
 * Now this client talks DIRECTLY to the Python backend running on the user's
 * own machine (started by the Electron installer, or by `python server.py`).
 *
 * Two base URLs:
 *   - BACKEND_URL  → Python FastAPI on http://localhost:8000 (lip-sync, tts, …)
 *   - AUTH_BASE    → "" (relative) → Next.js on Vercel for login/register/logout
 *                    (auth needs the JWT cookie, which is scoped to the web app)
 *
 * CORS note: the Python backend already has `CORSMiddleware` enabled in
 * server.py allowing all origins, so cross-origin fetches from the PWA
 * (served from Vercel) to localhost:8000 work out of the box.
 */

// The Python backend URL. Read from env in case the user runs it on a non-default
// port, but default to http://localhost:8000 which is what `python server.py` uses.
const BACKEND_URL =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_BACKEND_URL) ||
  "http://localhost:8000";

// Auth requests stay on the same origin (Vercel) — they need the httpOnly JWT cookie.
const AUTH_BASE = "";

export interface LipSyncJobStatus {
  job_id: string;
  status: "processing" | "completed" | "error" | "pending";
  progress: number;
  message: string;
  error: string | null;
  error_type?: string | null;
  has_video: boolean;
}

export interface DetectedFace {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] بالـ pixels بالنسبة للصورة الأصلية
  confidence: number;
  index: number;
}

export interface DetectFacesResponse {
  faces: DetectedFace[];
  image_width: number;
  image_height: number;
  count: number;
}

export interface TtsVoice {
  id: string;
  name: string;
  gender: "Male" | "Female";
  lang: string;
  label_ar: string;
  label_en: string;
  category?: "adult" | "child";  // بالغ أو طفل
  pitch?: string;                 // طبقة الصوت (لأصوات الأطفال)
}

export interface VoicesResponse {
  voices: TtsVoice[];
  default: string;
  error?: string;
}

/**
 * يجيب قائمة الأصوات من ال backend
 */
export async function listVoices(): Promise<VoicesResponse> {
  try {
    const res = await fetch(`${BACKEND_URL}/voices`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Voices fetch failed: ${res.status}`);
    return res.json();
  } catch (e: any) {
    return {
      voices: [],
      default: "ar-EG-SalmaNeural",
      error: e?.message || "Voices unavailable",
    };
  }
}

/**
 * يولّد معاينة صوتية من نص (MP3 blob)
 */
export async function previewTts(
  text: string,
  voice: string,
  rate = "+0%"
): Promise<Blob> {
  const formData = new FormData();
  formData.append("text", text);
  formData.append("voice", voice);
  formData.append("rate", rate);

  const res = await fetch(`${BACKEND_URL}/tts`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TTS failed: ${res.status} ${errText}`);
  }
  return res.blob();
}

/**
 * يكشف كل الوجوه في صورة (لو الصورة فيها أكتر من وجه).
 * بيرجع list من الوجوه مع bbox و index عشان المستخدم يختار اللي هيتكلم.
 */
export async function detectFaces(imageBlob: Blob, imageName = "image.png"): Promise<DetectFacesResponse> {
  const formData = new FormData();
  formData.append("file", imageBlob, imageName);

  const res = await fetch(`${BACKEND_URL}/detect-faces`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Face detection failed: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * يبدأ عملية الـ lip sync
 * - لو script موجود، الباك هاند هيولّد الصوت بـ TTS
 * - لو audioFile موجود، الباك هاند هيستخدمه مباشرة
 * لازم واحد منهم على الأقل
 * - لو faceIndex >= 0، السيرفر هيستخدم الوجه المحدد بس (للصور اللي فيها أكتر من وجه)
 */
export async function startLipSync(
  imageBlob: Blob,
  options: {
    audioFile?: Blob | File | null;
    scriptText?: string;
    voice?: string;
    rate?: string;
    imageName?: string;
    audioName?: string;
    pads?: string;
    resizeFactor?: number;
    faceIndex?: number;       // index الوجه اللي هيتكلم (-1 أو undefined = تلقائي)
  }
): Promise<{ job_id: string }> {
  const {
    audioFile,
    scriptText,
    voice = "ar-EG-SalmaNeural",
    rate = "+0%",
    imageName = "character.png",
    audioName = "audio.wav",
    pads = "0,10,0,0",
    resizeFactor = 1,
    faceIndex = -1,
  } = options;

  if (!audioFile && !scriptText?.trim()) {
    throw new Error("لازم ترفع صوت أو تكتب سكربت");
  }

  const formData = new FormData();
  formData.append("file", imageBlob, imageName);
  if (audioFile) {
    formData.append("audio", audioFile, audioName);
  }
  if (scriptText) {
    formData.append("text", scriptText);
  }
  formData.append("voice", voice);
  formData.append("rate", rate);
  formData.append("pads", pads);
  formData.append("resize_factor", String(resizeFactor));
  formData.append("face_index", String(faceIndex));

  // retry logic عشان لو الباك-إند وقع (OOM) واتـrestart، نديله فرصة يرجع
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 4000;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/lip-sync`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        return res.json();
      }

      // 503/502 = السيرفر بيسترجع، حاول تاني
      if (res.status === 503 || res.status === 502) {
        const text = await res.text();
        lastErr = new Error(`Lip sync start failed: ${res.status} ${text}`) as Error & { error_type?: string };
        (lastErr as any).error_type = "backend_unavailable";
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        throw lastErr;
      }

      // أي خطأ تاني: ارميه على طول
      const text = await res.text();
      throw new Error(`Lip sync start failed: ${res.status} ${text}`);
    } catch (e: any) {
      // network error (fetch threw) = السيرفر وقع بالكامل، حاول تاني
      if (e?.error_type === "backend_unavailable") {
        throw e; // ده من الـ 503 retry loop فوق، ارميه
      }
      lastErr = e instanceof Error ? e : new Error(String(e));
      (lastErr as any).error_type = "backend_unavailable";
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error("Lip sync start failed after retries");
}

// ============================================================
// Multi-speaker lip-sync (حوار بين أكتر من شخصية)
// ============================================================

/**
 * Script entry واحد في حوار متعدد المتحدثين.
 * - face_index: index الوجه اللي هيتكلم (من detect-faces)
 * - text: السكربت اللي هيتقال
 * - voice: voice id لـ TTS (اختياري، default ar-EG-SalmaNeural)
 * - rate: سرعة الكلام (اختياري، default +0%)
 */
export interface MultiScriptEntry {
  face_index: number;
  text: string;
  voice?: string;
  rate?: string;
}

/**
 * يبدأ عملية lip-sync متعددة المتحدثين.
 *
 * كل entry في scripts بيمثل فقرة حوار — الشخصية اللي في face_index
 * بتقول الـ text بالـ voice المحدد.
 * الباك-إند بيعالج كل فقرة بالترتيب ويدمجهم في فيديو واحد.
 *
 * الاستخدام:
 *   const { job_id } = await startMultiLipSync(imageFile, [
 *     { face_index: 0, text: "مرحبا، أنا الشخص الأول", voice: "ar-EG-SalmaNeural" },
 *     { face_index: 1, text: "وأنا الشخص الثاني", voice: "ar-EG-HamedNeural" },
 *   ]);
 *   const finalStatus = await pollJobUntilDone(job_id, onProgress);
 *   const blob = await downloadVideo(job_id);
 */
export async function startMultiLipSync(
  imageBlob: Blob,
  scripts: MultiScriptEntry[],
  imageName = "character.png"
): Promise<{ job_id: string; total_segments: number }> {
  if (!scripts || scripts.length === 0) {
    throw new Error("scripts لازم يكون array غير فاضي");
  }

  // Validate entries
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    if (typeof s.face_index !== "number" || s.face_index < 0) {
      throw new Error(`Entry ${i}: face_index لازم يكون رقم >= 0`);
    }
    if (!s.text || !s.text.trim()) {
      throw new Error(`Entry ${i}: النص فاضي`);
    }
  }

  if (scripts.length > 6) {
    throw new Error("حد أقصى 6 فقرات حوار للفيديو الواحد");
  }

  const formData = new FormData();
  formData.append("file", imageBlob, imageName);
  formData.append("scripts", JSON.stringify(scripts));

  // retry logic عشان لو الباك-إند وقع (OOM) واتـrestart
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 4000;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/lip-sync-multi`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        return res.json();
      }

      // 503/502 = السيرفر بيسترجع، حاول تاني
      if (res.status === 503 || res.status === 502) {
        const text = await res.text();
        lastErr = new Error(`Multi lip-sync start failed: ${res.status} ${text}`) as Error & { error_type?: string };
        (lastErr as any).error_type = "backend_unavailable";
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        throw lastErr;
      }

      // أي خطأ تاني: ارميه على طول
      const text = await res.text();
      throw new Error(`Multi lip-sync start failed: ${res.status} ${text}`);
    } catch (e: any) {
      if (e?.error_type === "backend_unavailable") {
        throw e;
      }
      lastErr = e instanceof Error ? e : new Error(String(e));
      (lastErr as any).error_type = "backend_unavailable";
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error("Multi lip-sync start failed after retries");
}

/**
 * يستعلم عن حالة الـ job
 *
 * فيه retry logic عشان لو الباك-إند وقع (OOM مثلاً) واتـrestart:
 * - 503/502: السيرفر بيسترجع، استنى 3 ثواني وحاول تاني (حتى 5 محاولات)
 * - network error: نفس السلوك
 * ده بيدّي فرصة للـ backend إنه يرجع شغال من غير ما الـ user يشوف خطأ كاذب.
 */
export async function getJobStatus(jobId: string): Promise<LipSyncJobStatus> {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/status/${jobId}`);
      if (res.ok) {
        return res.json();
      }
      // 503/502 = السيرفر بيسترجع (OOM crash + auto-restart)، حاول تاني
      if (res.status === 503 || res.status === 502) {
        lastErr = new Error(`Backend temporarily unavailable (${res.status})`);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
      }
      // أي خطأ تاني: ارميه على طول (404 = job مش موجود، 500 = خطأ حقيقي)
      const text = await res.text();
      throw new Error(`Status check failed: ${res.status} ${text}`);
    } catch (e: any) {
      // network error (fetch threw) = السيرفر وقع بالكامل، حاول تاني
      if (e?.message?.includes("Status check failed")) {
        throw e; // خطأ HTTP واضح، ارميه
      }
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    }
  }
  throw lastErr || new Error("Status check failed after retries");
}

/**
 * يحمل الفيديو الناتج
 */
export async function downloadVideo(jobId: string): Promise<Blob> {
  const res = await fetch(`${BACKEND_URL}/download/${jobId}`);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }
  return res.blob();
}

/**
 * ينظف الـ job من السيرفر
 */
export async function cleanupJob(jobId: string): Promise<void> {
  try {
    await fetch(`${BACKEND_URL}/jobs/${jobId}`, { method: "DELETE" });
  } catch {
    // ignore
  }
}

/**
 * يراقب حالة الـ job حتى تخلص (أو تطفي)
 *
 * فيه resilience ضد انقطاع الباك-إند:
 * - لو getJobStatus فشلت بشبكة/503، نعدّ المحاولات المتتالية
 * - لو وصلنا لـ 10 أخطاء متتالية (~15 ثانية مع retry)، نرمي خطأ واضح
 * - لو الـ status رجع "error" من السيرفر، نرمي الـ error_type الصحيح
 */
export async function pollJobUntilDone(
  jobId: string,
  onProgress: (status: LipSyncJobStatus) => void,
  intervalMs = 1500,
  maxAttempts = 200
): Promise<LipSyncJobStatus> {
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const status = await getJobStatus(jobId);
      consecutiveErrors = 0; // نجاح، صفّر العدّاد
      onProgress(status);

      if (status.status === "completed") {
        return status;
      }
      if (status.status === "error") {
        const err = new Error(status.error || status.message || "Job failed") as Error & { error_type?: string };
        err.error_type = status.error_type || "unknown";
        throw err;
      }
    } catch (e: any) {
      // لو الخطأ من نوع "error status" من السيرفر (مش network)، ارميه على طول
      if (e?.error_type) {
        throw e;
      }
      // network/503 error — ممكن الباك-إند بيسترجع، كمّل المحاولات
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        const err = new Error(
          "السيرفر وقع أثناء المعالجة. حاول تاني بصورة أصغر أو نص أقصر — " +
          "الذاكرة مش كافية على السيرفر."
        ) as Error & { error_type?: string };
        err.error_type = "backend_crashed";
        throw err;
      }
      // استنى شوية قبل المحاولة الجاية (مش هنستنى intervalMs كمان عشان getJobStatus فيه retry بتاعه)
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error("Job timed out") as Error & { error_type?: string };
  err.error_type = "timeout";
  throw err;
}

/**
 * فحص صحة الـ backend
 */
export async function checkBackendHealth(): Promise<{
  status: string;
  device: string;
  model_loaded: boolean;
  wav2lip_available?: boolean;
  tts_available?: boolean;
}> {
  const res = await fetch(`${BACKEND_URL}/health`);
  if (!res.ok) throw new Error("Backend not reachable");
  return res.json();
}

/**
 * فحص سريع للـ backend — بيرجع true/false بس من غير ما يرمي استثناء.
 * بيستخدم abort signal بـ 1500ms عشان ما يعملش block للـ UI لو السيرفر بطيء.
 *
 * مهم: ده بيتكلم مباشرة مع http://localhost:8000 (مش الـ Vercel proxy).
 * الـ /api/health اللي على Vercel بيرجع "ok" دايماً حتى لو الـ backend
 * المحلي مش شغال، فلازم نستخدم ده للتشخيص الحقيقي.
 */
export async function isBackendReachable(timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${BACKEND_URL}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * يعيد تشغيل الـ backend المحلي عبر Electron IPC.
 * - بيشتغل بس جوه تطبيق الديسكتوب (مش في المتصفح).
 * - بيرجع { success, error? }.
 *
 * الاستخدام: لما الـ backend يقع أثناء معالجة فيديو (OOM)، المستخدم
 * يقدر يضغط "إعادة تشغيل السيرفر" من الـ UI بدل ما يقفل التطبيق كله.
 */
export async function restartDesktopBackend(): Promise<{ success: boolean; error?: string }> {
  // window.backend موجود بس جوه Electron (شوف desktop/src/preload.js)
  const backendApi = (typeof window !== "undefined" && (window as any).backend) || null;
  if (!backendApi || typeof backendApi.restart !== "function") {
    return {
      success: false,
      error: "restart غير متاح — أنت مش جوه تطبيق الديسكتوب",
    };
  }
  try {
    return await backendApi.restart();
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

/**
 * يعمل pre-flight check قبل ما يبدأ lip-sync أو توليد صورة.
 * - لو الـ backend مش متاح، بيرجع رسالة خطأ واضحة.
 * - لو متاح، بيرجع null (يعني كمل).
 *
 * استخدم ده قبل أي طلب للـ backend عشان تدي المستخدم رسالة واضحة بدل
 * ما يطول 30 ثانية ويرجع "السيرفر مش متاح".
 */
export async function preflightBackendCheck(language: "ar" | "en" = "ar"): Promise<string | null> {
  const reachable = await isBackendReachable(2000);
  if (reachable) return null;
  return language === "ar"
    ? "السيرفر المحلي مش شغال. لو التطبيق لسه شغال، استنى دقيقة علشان النماذج تحمّل. لو وقع، اضغط 'إعادة تشغيل السيرفر'."
    : "Local backend is not running. If the app just started, wait ~1 min for models to load. If it crashed, click 'Restart Server'.";
}

// ============================================================
// توليد الشخصيات بالـ AI (Character Generation)
// ============================================================

export interface CharacterStyle {
  id: string;
  label: string;
}

export interface CharacterGender {
  id: string;
  label_ar: string;
  label_en: string;
}

export interface GenerateCharacterOptions {
  prompt: string;
  style?: string;       // realistic | anime | cartoon | 3d | oil | watercolor
  gender?: string;      // male | female | any
  language?: "ar" | "en";
}

export interface GeneratedCharacter {
  success: boolean;
  image_base64: string;       // PNG base64 (بدون data: prefix)
  image_mime: string;
  prompt_used: string;        // الـ prompt البصري اللي اتولّد
  description_ar: string;
  description_en: string;
  style: string;
  gender: string;
  error?: string;             // موجود لو success=false
}

/**
 * يجيب قائمة الـ styles و الـ genders المتاحة لتوليد الشخصيات.
 */
export async function getCharacterOptions(): Promise<{
  styles: CharacterStyle[];
  genders: CharacterGender[];
}> {
  try {
    const res = await fetch(`${BACKEND_URL}/generate-character`, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    return res.json();
  } catch {
    // fallback ثابت
    return {
      styles: [
        { id: "realistic", label: "واقعي / Realistic" },
        { id: "anime", label: "أنمي / Anime" },
        { id: "cartoon", label: "كرتون / Cartoon" },
        { id: "3d", label: "3D" },
        { id: "oil", label: "زيت / Oil" },
        { id: "watercolor", label: "ألوان مائية / Watercolor" },
      ],
      genders: [
        { id: "any", label_ar: "أي نوع", label_en: "Any" },
        { id: "male", label_ar: "ذكر", label_en: "Male" },
        { id: "female", label_ar: "أنثى", label_en: "Female" },
      ],
    };
  }
}

/**
 * يولّد شخصية جديدة بالـ AI من وصف نصي.
 * - يستخدم job-based pattern: POST يبدأ الشغل ويرجع job_id، وبعدين poll كل 2s.
 * - ده عشان نتجنب proxy/ALB timeout (الـ streaming approach كان بيتقطع بعد 30s).
 * - onProgress callback عشان الـ UI يعرض التقدم + الوقت المنقضي.
 *
 * timeout: 6 دقايق (180 محاولة × 2s). الـ backend بياخد لـ 180s في الـ subprocess
 * + محاولات retry لو فلتر المحتوى رفض الـ prompt. الـ 120s القديمة كانت بتنتهي
 * قبل ما الـ backend يخلص، فكان يظهر للمستخدم "الـ AI بطيء" بالرغم إن الشغل
 * لسه شغال في الـ background.
 */
export async function generateCharacter(
  options: GenerateCharacterOptions,
  onProgress?: (progress: number, message: string, elapsedSec?: number) => void
): Promise<GeneratedCharacter> {
  const { prompt, style = "realistic", gender = "any", language = "ar" } = options;

  if (!prompt.trim()) {
    throw new Error(language === "ar" ? "اكتب وصف للشخصية" : "Describe the character first");
  }

  const t0 = Date.now();
  const elapsed = () => Math.floor((Date.now() - t0) / 1000);

  // 1. ابدأ الـ job
  onProgress?.(5, language === "ar" ? "بدء التوليد..." : "Starting...", 0);
  const startRes = await fetch(`${BACKEND_URL}/generate-character`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, style, gender, language }),
  });

  if (!startRes.ok) {
    let errMsg = `Generation failed (HTTP ${startRes.status})`;
    try {
      const errBody = await startRes.json();
      if (errBody?.error) errMsg = errBody.error;
    } catch {}
    throw new Error(errMsg);
  }

  const startBody = await startRes.json();
  const jobId = startBody.job_id;
  if (!jobId) {
    throw new Error(language === "ar" ? "فشل بدء التوليد" : "Failed to start generation");
  }

  // 2. Poll للحالة كل 2 ثانية (حد أقصى 360 ثانية = 6 دقايق)
  //    - الـ backend بياخد عادة 15-40 ثانية
  //    - لو فلتر المحتوى رفض، الـ backend بيعيد المحاولة 4 مرات مع rephrase
  //    - كل retry بياخد ~30s، فالمجموع ممكن يوصل لـ 150s
  //    - 360s بتدي buffer كافي + تتحسب لأي network hiccup
  const maxAttempts = 180;
  let consecutiveErrors = 0;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    let pollRes: Response | null = null;
    try {
      pollRes = await fetch(`${BACKEND_URL}/generate-character?id=${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });
      consecutiveErrors = 0;
    } catch {
      // network hiccup — retry
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        throw new Error(
          language === "ar"
            ? "فقد الاتصال بالسيرفر — اتأكد من النت وحاول تاني"
            : "Lost connection to server — check network and retry"
        );
      }
      continue;
    }
    if (!pollRes.ok) {
      if (pollRes.status === 404) {
        throw new Error(language === "ar" ? "انتهت صلاحية الطلب - حاول تاني" : "Job expired - try again");
      }
      continue;
    }

    const data: GeneratedCharacter & { status: string; progress: number; message: string } = await pollRes.json();

    // حدّث الـ progress على أساس الوقت المنقضي (مزيف بس بيدي إحساس بالتقدم)
    // الـ backend مابيرجّعش progress حقيقي أثناء الـ image generation،
    // فبنحسب تقدير بناءً على إن المعدل الطبيعي 15-40s.
    const secs = elapsed();
    const fakeProgress = Math.min(95, 5 + Math.floor((secs / 60) * 80));
    const displayProgress = Math.max(data.progress || 0, fakeProgress);
    const displayMessage = data.message || (language === "ar"
      ? `جاري التوليد... ${secs}s`
      : `Generating... ${secs}s`);
    onProgress?.(displayProgress, displayMessage, secs);

    if (data.status === "completed") {
      if (!data.image_base64 || data.image_base64.length < 1000) {
        throw new Error(
          language === "ar"
            ? "الـ AI رجّع صورة فاضية - حاول تاني بوصف مختلف"
            : "AI returned empty image - try again with a different description"
        );
      }
      onProgress?.(100, language === "ar" ? "اكتمل" : "Done", secs);
      return {
        success: true,
        image_base64: data.image_base64,
        image_mime: data.image_mime || "image/png",
        prompt_used: data.prompt_used || "",
        description_ar: data.description_ar || "",
        description_en: data.description_en || "",
        style: data.style || style,
        gender: data.gender || gender,
      };
    }

    if (data.status === "error") {
      const errMsg = data.error || (language === "ar" ? "فشل التوليد" : "Generation failed");
      const errType = (data as any).error_type || "unknown";
      const e = new Error(errMsg) as Error & { error_type?: string };
      e.error_type = errType;
      throw e;
    }
    // status === "processing" → keep polling
  }

  // Time-out بعد 6 دقايق. الرسالة أوضح من "AI is slow" — نوضّح إن الـ backend
  // لسه شغال في الـ background، والمستخدم يقدر يحاول تاني بوصف أبسط.
  const e = new Error(
    language === "ar"
      ? `انتهت صلاحية الانتظار بعد 6 دقايق. الـ AI ممكن يكون مشغول أو بيقفل فلتر المحتوى. جرّب وصف أبسط أو حاول تاني بعد شوية.`
      : `Timed out after 6 minutes. The AI may be busy or hitting content filter. Try a simpler prompt or retry in a moment.`
  ) as Error & { error_type?: string };
  e.error_type = "timeout";
  throw e;
}

/**
 * يحوّل base64 PNG إلى File object عشان يبقى متوافق مع بقية الـ flow
 * (نفس الـ interface بتاع رفع الصورة).
 */
export function base64ImageToFile(
  base64: string,
  mime: string = "image/png",
  filename: string = "ai-character.png"
): File {
  // نظّف الـ data URL prefix لو موجود
  const cleaned = base64.replace(/^data:[^;]+;base64,/, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mime });
  return new File([blob], filename, { type: mime });
}

// ============================================================
// تعديل الشخصيات بالـ AI (Image-to-Image Editing)
// ============================================================

export interface EditCharacterOptions {
  image_base64: string;       // الصورة الأصلية (base64 بدون data: prefix)
  edit_prompt: string;        // وصف التعديل المطلوب
  language?: "ar" | "en";
}

export interface EditedCharacter {
  success: boolean;
  image_base64: string;
  image_mime: string;
  prompt_used: string;
  error?: string;
}

/**
 * يعدّل صورة شخصية موجودة بالـ AI بناءً على وصف نصي.
 * - يستخدم job-based pattern زي generateCharacter.
 * - onProgress callback عشان الـ UI يعرض التقدم + الوقت المنقضي.
 * - timeout كبير (180s) + retry على network errors.
 */
export async function editCharacter(
  options: EditCharacterOptions,
  onProgress?: (progress: number, message: string, elapsedSec?: number) => void
): Promise<EditedCharacter> {
  const { image_base64, edit_prompt, language = "ar" } = options;

  if (!image_base64 || image_base64.length < 1000) {
    throw new Error(language === "ar" ? "صورة غير صالحة" : "Invalid image");
  }
  if (!edit_prompt.trim()) {
    throw new Error(language === "ar" ? "اكتب التعديل المطلوب" : "Describe the edit");
  }

  const t0 = Date.now();
  const elapsed = () => Math.floor((Date.now() - t0) / 1000);

  console.log("[editCharacter] Starting edit job", {
    image_size: image_base64.length,
    prompt: edit_prompt.slice(0, 60),
    language,
  });

  // 1. ابدأ الـ job
  onProgress?.(5, language === "ar" ? "بتعديل الصورة..." : "Editing image...", 0);
  const startRes = await fetch(`${BACKEND_URL}/edit-character`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64, edit_prompt: edit_prompt.trim(), language }),
  });

  if (!startRes.ok) {
    let errMsg = `Edit failed (HTTP ${startRes.status})`;
    try {
      const errBody = await startRes.json();
      if (errBody?.error) errMsg = errBody.error;
    } catch {}
    console.error("[editCharacter] POST failed:", startRes.status, errMsg);
    throw new Error(errMsg);
  }

  const startBody = await startRes.json();
  const jobId = startBody.job_id;
  if (!jobId) {
    throw new Error(language === "ar" ? "فشل بدء التعديل" : "Failed to start edit");
  }

  console.log("[editCharacter] Job started:", jobId);

  // 2. Poll كل 2 ثانية (حد أقصى 180 ثانية = 90 محاولة)
  //    التعديل بالـ AI بياخد بين 15-60 ثانية عادةً.
  const maxAttempts = 90;
  let consecutiveErrors = 0;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    let pollRes: Response | null = null;
    try {
      pollRes = await fetch(`${BACKEND_URL}/edit-character?id=${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });
      consecutiveErrors = 0;
    } catch (e: any) {
      consecutiveErrors++;
      console.warn(`[editCharacter] Poll #${i} network error:`, e?.message);
      // اكمل لو أقل من 5 أخطاء ورا بعض
      if (consecutiveErrors >= 5) {
        throw new Error(
          language === "ar"
            ? "فقد الاتصال بالسيرفر - اتأكد من النت وجرّب تاني"
            : "Lost connection - check network and retry"
        );
      }
      continue;
    }

    if (!pollRes.ok) {
      if (pollRes.status === 404) {
        throw new Error(language === "ar" ? "انتهت صلاحية الطلب" : "Job expired");
      }
      console.warn(`[editCharacter] Poll #${i} HTTP ${pollRes.status}`);
      continue;
    }

    let data: EditedCharacter & { status: string; progress: number; message: string };
    try {
      data = await pollRes.json();
    } catch (e: any) {
      console.warn(`[editCharacter] Poll #${i} JSON parse error:`, e?.message);
      continue;
    }

    // اختياري: سجّل كل poll للتشخيص
    if (i % 5 === 0 || i < 3) {
      console.log(`[editCharacter] Poll #${i} status=${data.status} progress=${data.progress} elapsed=${elapsed()}s`);
    }

    // حدّث الـ progress على أساس الوقت المنقضي (مزيف بس بيدي إحساس بالتقدم)
    const fakeProgress = Math.min(95, 10 + Math.floor((elapsed() / 60) * 85));
    const displayProgress = Math.max(data.progress || 0, fakeProgress);
    onProgress?.(displayProgress, data.message || (language === "ar" ? "جاري التعديل..." : "Editing..."), elapsed());

    if (data.status === "completed") {
      if (!data.image_base64 || data.image_base64.length < 1000) {
        throw new Error(
          language === "ar" ? "فشل التعديل - حاول تاني" : "Edit failed - try again"
        );
      }
      console.log(`[editCharacter] Edit completed in ${elapsed()}s`);
      onProgress?.(100, language === "ar" ? "اكتمل التعديل" : "Done", elapsed());
      return {
        success: true,
        image_base64: data.image_base64,
        image_mime: data.image_mime || "image/png",
        prompt_used: data.prompt_used || edit_prompt,
      };
    }

    if (data.status === "error") {
      const errMsg = data.error || (language === "ar" ? "فشل التعديل" : "Edit failed");
      const errType = (data as any).error_type || "unknown";
      console.error(`[editCharacter] Edit failed after ${elapsed()}s type=${errType}:`, errMsg);
      const e = new Error(errMsg) as Error & { error_type?: string };
      e.error_type = errType;
      throw e;
    }
  }

  console.error(`[editCharacter] Timed out after ${elapsed()}s`);
  throw new Error(
    language === "ar" ? `انتهى الوقت (${elapsed()}ث) - حاول تاني` : `Timed out (${elapsed()}s) - try again`
  );
}
