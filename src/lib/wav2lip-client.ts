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
 * - يرجع base64 PNG + وصف بالعربي والإنجليزي.
 * - لا يحتاج الـ Python backend - ده Node.js فقط.
 */
export async function generateCharacter(
  options: GenerateCharacterOptions
): Promise<GeneratedCharacter> {
  const { prompt, style = "realistic", gender = "any", language = "ar" } = options;

  if (!prompt.trim()) {
    throw new Error(language === "ar" ? "اكتب وصف للشخصية" : "Describe the character first");
  }

  // استخدام AbortController عشان نضمن مهلة 90 ثانية (الـ AI بياخد ~30 ثانية عادة)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch(`/api/generate-character`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, style, gender, language }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let errMsg = `Generation failed (${res.status})`;
      try {
        const errBody = await res.json();
        if (errBody?.error) errMsg = errBody.error;
      } catch {
        // ignore
      }
      throw new Error(errMsg);
    }

    return res.json();
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(
        language === "ar"
          ? "انتهى الوقت - الـ AI بطيء. حاول تاني."
          : "Timed out - AI is slow. Try again."
      );
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
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
