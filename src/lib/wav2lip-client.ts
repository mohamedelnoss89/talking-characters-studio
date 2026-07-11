/**
 * Wav2Lip API Client
 * يتصل مع الـ Python backend عن طريق Next.js API routes (proxy)
 * عشان يشتغل من أي browser حتى لو الـ backend على server تاني
 */

// نستخدم relative URLs - الـ Next.js API routes بتعمل proxy للـ backend
const API_BASE = "";

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
}

export interface VoicesResponse {
  voices: TtsVoice[];
  default: string;
  error?: string;
}

/**
 * يجيب قائمة الأصوات من الـ backend
 */
export async function listVoices(): Promise<VoicesResponse> {
  try {
    const res = await fetch(`/api/voices`, { cache: "no-store" });
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

  const res = await fetch(`/api/tts`, {
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

  const res = await fetch(`/api/detect-faces`, {
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
      const res = await fetch(`/api/lip-sync`, {
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
      const res = await fetch(`/api/status/${jobId}`);
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
  const res = await fetch(`/api/download/${jobId}`);
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
    await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
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
  const res = await fetch(`/api/health`);
  if (!res.ok) throw new Error("Backend not reachable");
  return res.json();
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
    const res = await fetch(`/api/generate-character`, { cache: "no-store" });
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
 * - onProgress callback عشان الـ UI يعرض التقدم.
 */
export async function generateCharacter(
  options: GenerateCharacterOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<GeneratedCharacter> {
  const { prompt, style = "realistic", gender = "any", language = "ar" } = options;

  if (!prompt.trim()) {
    throw new Error(language === "ar" ? "اكتب وصف للشخصية" : "Describe the character first");
  }

  // 1. ابدأ الـ job
  onProgress?.(5, language === "ar" ? "بدء التوليد..." : "Starting...");
  const startRes = await fetch(`/api/generate-character`, {
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

  // 2. Poll للحالة كل 2 ثانية (حد أقصى 120 ثانية)
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    let pollRes: Response;
    try {
      pollRes = await fetch(`/api/generate-character?id=${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });
    } catch {
      // network hiccup — retry
      continue;
    }

    if (!pollRes.ok) {
      if (pollRes.status === 404) {
        throw new Error(language === "ar" ? "انتهت صلاحية الطلب - حاول تاني" : "Job expired - try again");
      }
      continue;
    }

    const data: GeneratedCharacter & { status: string; progress: number; message: string } = await pollRes.json();
    onProgress?.(data.progress || 0, data.message || "");

    if (data.status === "completed") {
      if (!data.image_base64 || data.image_base64.length < 1000) {
        throw new Error(
          language === "ar"
            ? "الـ AI رجّع صورة فاضية - حاول تاني بوصف مختلف"
            : "AI returned empty image - try again with a different description"
        );
      }
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

  const e = new Error(
    language === "ar" ? "انتهى الوقت - الـ AI بطيء. حاول تاني." : "Timed out - AI is slow. Try again."
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
  const startRes = await fetch(`/api/edit-character`, {
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
      pollRes = await fetch(`/api/edit-character?id=${encodeURIComponent(jobId)}`, {
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
