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

/**
 * يبدأ عملية الـ lip sync
 * Returns: job_id
 */
export async function startLipSync(
  imageBlob: Blob,
  audioBlob: Blob,
  imageName = "character.png",
  audioName = "audio.wav",
  pads = "0,10,0,0",
  resizeFactor = 1
): Promise<{ job_id: string }> {
  const formData = new FormData();
  formData.append("file", imageBlob, imageName);
  formData.append("audio", audioBlob, audioName);
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
