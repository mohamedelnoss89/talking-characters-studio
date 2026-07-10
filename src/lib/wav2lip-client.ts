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
  has_video: boolean;
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
 * يبدأ عملية الـ lip sync
 * - لو script موجود، الباك هاند هيولّد الصوت بـ TTS
 * - لو audioFile موجود، الباك هاند هيستخدمه مباشرة
 * لازم واحد منهم على الأقل
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

  const res = await fetch(`/api/lip-sync`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lip sync start failed: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * يستعلم عن حالة الـ job
 */
export async function getJobStatus(jobId: string): Promise<LipSyncJobStatus> {
  const res = await fetch(`/api/status/${jobId}`);
  if (!res.ok) {
    throw new Error(`Status check failed: ${res.status}`);
  }
  return res.json();
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
 */
export async function pollJobUntilDone(
  jobId: string,
  onProgress: (status: LipSyncJobStatus) => void,
  intervalMs = 1500,
  maxAttempts = 200
): Promise<LipSyncJobStatus> {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await getJobStatus(jobId);
    onProgress(status);

    if (status.status === "completed") {
      return status;
    }
    if (status.status === "error") {
      throw new Error(status.error || status.message || "Job failed");
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Job timed out");
}

/**
 * فحص صحة الـ backend
 */
export async function checkBackendHealth(): Promise<{
  status: string;
  device: string;
  model_loaded: boolean;
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
      throw new Error(data.error || (language === "ar" ? "فشل التوليد" : "Generation failed"));
    }
    // status === "processing" → keep polling
  }

  throw new Error(
    language === "ar" ? "انتهى الوقت - الـ AI بطيء. حاول تاني." : "Timed out - AI is slow. Try again."
  );
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
 * - onProgress callback عشان الـ UI يعرض التقدم.
 */
export async function editCharacter(
  options: EditCharacterOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<EditedCharacter> {
  const { image_base64, edit_prompt, language = "ar" } = options;

  if (!image_base64 || image_base64.length < 1000) {
    throw new Error(language === "ar" ? "صورة غير صالحة" : "Invalid image");
  }
  if (!edit_prompt.trim()) {
    throw new Error(language === "ar" ? "اكتب التعديل المطلوب" : "Describe the edit");
  }

  // 1. ابدأ الـ job
  onProgress?.(10, language === "ar" ? "بتعديل الصورة..." : "Editing image...");
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
    throw new Error(errMsg);
  }

  const startBody = await startRes.json();
  const jobId = startBody.job_id;
  if (!jobId) {
    throw new Error(language === "ar" ? "فشل بدء التعديل" : "Failed to start edit");
  }

  // 2. Poll كل 2 ثانية (حد أقصى 120 ثانية)
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    let pollRes: Response;
    try {
      pollRes = await fetch(`/api/edit-character?id=${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });
    } catch {
      continue;
    }

    if (!pollRes.ok) {
      if (pollRes.status === 404) {
        throw new Error(language === "ar" ? "انتهت صلاحية الطلب" : "Job expired");
      }
      continue;
    }

    const data: EditedCharacter & { status: string; progress: number; message: string } = await pollRes.json();
    onProgress?.(data.progress || 0, data.message || "");

    if (data.status === "completed") {
      if (!data.image_base64 || data.image_base64.length < 1000) {
        throw new Error(
          language === "ar" ? "فشل التعديل - حاول تاني" : "Edit failed - try again"
        );
      }
      return {
        success: true,
        image_base64: data.image_base64,
        image_mime: data.image_mime || "image/png",
        prompt_used: data.prompt_used || edit_prompt,
      };
    }

    if (data.status === "error") {
      throw new Error(data.error || (language === "ar" ? "فشل التعديل" : "Edit failed"));
    }
  }

  throw new Error(
    language === "ar" ? "انتهى الوقت - حاول تاني" : "Timed out - try again"
  );
}
