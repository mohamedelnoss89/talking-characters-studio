'use client';

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  Upload,
  Music,
  Settings as SettingsIcon,
  Play,
  Square,
  Download,
  Sparkles,
  Eye,
  AudioLines,
  CheckCircle2,
  Loader2,
  Globe,
  Cpu,
  Zap,
  AlertCircle,
} from "lucide-react";
import { translations, type Language } from "@/lib/i18n";
import { Toaster } from "@/components/ui/toaster";
import {
  startLipSync,
  pollJobUntilDone,
  downloadVideo,
  cleanupJob,
  checkBackendHealth,
  type LipSyncJobStatus,
} from "@/lib/wav2lip-client";

const CHARACTER_FILES = Array.from({ length: 18 }, (_, i) => {
  const num = String(i + 1).padStart(2, "0");
  return `/characters/char_${num}.png`;
});

// Convert AudioBuffer to WAV Blob (للمعاينة الصوتية)
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;

  let result: Float32Array;
  if (numChannels === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }

  const dataLength = result.length * (bitDepth / 8);
  const ab = new ArrayBuffer(44 + dataLength);
  const view = new DataView(ab);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  const offset = 44;
  for (let i = 0; i < result.length; i++) {
    const s = Math.max(-1, Math.min(1, result[i]));
    view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([ab], { type: "audio/wav" });
}

function interleave(left: Float32Array, right: Float32Array): Float32Array {
  const length = left.length + right.length;
  const result = new Float32Array(length);
  let index = 0;
  let inputIndex = 0;
  while (index < length) {
    result[index++] = left[inputIndex];
    result[index++] = right[inputIndex];
    inputIndex++;
  }
  return result;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Component to preview audio buffer
function AudioPreview({
  audioBuffer,
  fileName,
  duration,
}: {
  audioBuffer: AudioBuffer;
  fileName: string;
  duration: number;
}) {
  const [url, setUrl] = useState<string>("");

  useEffect(() => {
    const wavBlob = audioBufferToWav(audioBuffer);
    const u = URL.createObjectURL(wavBlob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [audioBuffer]);

  return (
    <div className="mt-4 p-4 rounded-lg bg-purple-500/10 border border-purple-500/20">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Music className="w-4 h-4 text-purple-300" />
          <span className="text-sm text-purple-100 truncate max-w-[200px]">{fileName}</span>
        </div>
        <Badge variant="secondary" className="bg-purple-500/20 text-purple-200">
          {duration.toFixed(1)}s
        </Badge>
      </div>
      {url && <audio controls className="w-full h-8" src={url} />}
    </div>
  );
}

export default function Home() {
  const [lang, setLang] = useState<Language>("ar");
  const t = translations[lang];

  const [selectedCharacter, setSelectedCharacter] = useState<number | null>(null);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null); // ملف الصورة الأصلي
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null); // ملف الصوت الأصلي
  const [audioFileName, setAudioFileName] = useState<string>("");
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateProgress, setGenerateProgress] = useState(0);
  const [generateMessage, setGenerateMessage] = useState<string>("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("character");
  const [debugInfo, setDebugInfo] = useState<string>("");
  const [imageReady, setImageReady] = useState(false);
  const [backendStatus, setBackendStatus] = useState<"checking" | "ok" | "down" | "starting">("checking");
  const [backendInfo, setBackendInfo] = useState<{ device: string; model_loaded: boolean } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const { toast } = useToast();

  // === فحص الـ backend ===
  useEffect(() => {
    let mounted = true;
    let retryCount = 0;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const health = await res.json();
        if (!mounted) return;
        if (health.status === "ok") {
          setBackendStatus("ok");
          setBackendInfo({ device: health.device, model_loaded: health.model_loaded });
        } else if (health.status === "starting") {
          setBackendStatus("starting");
          // Retry sooner if starting
          retryCount++;
          if (retryCount < 10) {
            setTimeout(check, 3000);
          }
        } else {
          setBackendStatus("down");
        }
      } catch {
        if (mounted) setBackendStatus("down");
      }
    };
    check();
    const id = setInterval(check, 30000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const loadCharacterImage = useCallback((src: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = src;
    });
  }, []);

  // === رسم معاينة الصورة على الـ canvas ===
  const drawPreview = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageRef.current) return;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0a0b10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const img = imageRef.current;
    const scale = Math.min(canvas.width / img.width, canvas.height / img.height) * 0.9;
    const sw = img.width * scale;
    const sh = img.height * scale;
    const dx = (canvas.width - sw) / 2;
    const dy = (canvas.height - sh) / 2;
    ctx.drawImage(img, dx, dy, sw, sh);

    // علامة "AI" في الزاوية
    ctx.fillStyle = "rgba(99, 102, 241, 0.9)";
    ctx.fillRect(canvas.width - 80, 12, 68, 24);
    ctx.fillStyle = "white";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText("Wav2Lip", canvas.width - 73, 28);
  }, []);

  // رسم المعاينة لما الصورة تتغير
  useEffect(() => {
    if (imageReady && !videoUrl) {
      drawPreview();
    }
  }, [imageReady, videoUrl, drawPreview]);

  // اختيار شخصية جاهزة - وتحميل الـ File object
  const handleSelectCharacter = async (index: number) => {
    setDebugInfo("");
    setSelectedCharacter(index);
    setUploadedImage(null);
    setVideoBlob(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    try {
      const img = await loadCharacterImage(CHARACTER_FILES[index]);
      imageRef.current = img;
      setImageReady(true);

      // حمّل الـ File object من الـ URL
      const resp = await fetch(CHARACTER_FILES[index]);
      const blob = await resp.blob();
      const file = new File([blob], `char_${String(index + 1).padStart(2, "0")}.png`, { type: "image/png" });
      setImageFile(file);

      toast({
        title: lang === "ar" ? "تم اختيار الشخصية" : "Character Selected",
        description: `#${index + 1} ${t.characters[index]}`,
      });
    } catch (e) {
      setDebugInfo(lang === "ar" ? "فشل تحميل الصورة" : "Failed to load image");
    }
  };

  // رفع صورة من الجهاز
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    setUploadedImage(url);
    setSelectedCharacter(null);
    setImageReady(false);
    setImageFile(file);
    setVideoBlob(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);

    try {
      const img = await loadCharacterImage(url);
      imageRef.current = img;
      setImageReady(true);
      toast({
        title: lang === "ar" ? "تم رفع الصورة" : "Image Uploaded",
        description: file.name,
      });
    } catch (e) {
      setDebugInfo(lang === "ar" ? "فشل تحميل الصورة" : "Failed to load image");
    }
  };

  // رفع ملف صوتي
  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setAudioFileName(file.name);
    setAudioFile(file);
    setDebugInfo("");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioContext();
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();
      setAudioBuffer(buffer);
      setAudioDuration(buffer.duration);
      toast({
        title: lang === "ar" ? "تم رفع الصوت" : "Audio Uploaded",
        description: `${file.name} (${buffer.duration.toFixed(1)}s)`,
      });
    } catch (e: any) {
      setDebugInfo(e?.message || "Failed to load audio");
      toast({
        variant: "destructive",
        title: lang === "ar" ? "خطأ" : "Error",
        description: lang === "ar" ? "فشل تحميل الصوت" : "Failed to load audio",
      });
    }
  };

  // === توليد الفيديو باستخدام Wav2Lip AI ===
  const handleGenerateAI = async () => {
    setDebugInfo("");
    if (!imageFile || !audioFile) {
      const msg = !imageFile
        ? (lang === "ar" ? "اختار شخصية الأول" : "Select a character first")
        : (lang === "ar" ? "ارفع ملف صوتي الأول" : "Upload an audio file first");
      setDebugInfo(msg);
      toast({
        variant: "destructive",
        title: lang === "ar" ? "بيانات ناقصة" : "Missing Data",
        description: msg,
      });
      if (!imageFile) setActiveTab("character");
      else setActiveTab("voice");
      return;
    }

    if (backendStatus !== "ok") {
      const msg = lang === "ar"
        ? backendStatus === "starting"
          ? "السيرفر بيشتغل، استنى ثواني وحاول تاني."
          : "الـ backend مش شغال. شغّل السيرفر الأول."
        : backendStatus === "starting"
        ? "Server is starting, wait a few seconds and retry."
        : "Backend not running. Start the server first.";
      setDebugInfo(msg);
      toast({
        variant: "destructive",
        title: lang === "ar" ? "خطأ في الاتصال" : "Connection Error",
        description: msg,
      });
      return;
    }

    setIsGenerating(true);
    setGenerateProgress(0);
    setGenerateMessage(lang === "ar" ? "بتجهيز الطلب..." : "Preparing request...");
    setVideoBlob(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);

    // ⚠️ defer tab switch to next tick to avoid React insertBefore race
    // (Next.js 16 + Turbopack + concurrent rendering)
    requestAnimationFrame(() => setActiveTab("preview"));

    try {
      // 1. ابدأ الـ job
      setGenerateMessage(lang === "ar" ? "بتقديم الطلب للـ AI..." : "Submitting to AI...");
      const { job_id } = await startLipSync(
        imageFile,
        audioFile,
        imageFile.name || "character.png",
        audioFile.name || "audio.wav",
        "0,10,0,0",
        1
      );
      jobIdRef.current = job_id;
      console.log("Job started:", job_id);

      // 2. راقب التقدم
      setGenerateMessage(lang === "ar" ? "الذكاء الاصطناعي بيشتغل..." : "AI is working...");
      const finalStatus: LipSyncJobStatus = await pollJobUntilDone(
        job_id,
        (status) => {
          setGenerateProgress(status.progress);
          setGenerateMessage(status.message || (lang === "ar" ? "جاري المعالجة..." : "Processing..."));
        },
        1500,
        240 // 6 دقائق timeout
      );

      console.log("Job completed:", finalStatus);

      // 3. حمّل الفيديو
      setGenerateMessage(lang === "ar" ? "بتحميل الفيديو..." : "Downloading video...");
      setGenerateProgress(100);
      const blob = await downloadVideo(job_id);

      const url = URL.createObjectURL(blob);
      setVideoBlob(blob);
      setVideoUrl(url);
      setGenerateMessage("");

      toast({
        title: t.successGenerated,
        description: `${(blob.size / 1024 / 1024).toFixed(1)} MB · MP4 · Wav2Lip AI`,
      });

      // 4. تنظيف
      setTimeout(() => cleanupJob(job_id), 30000);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setDebugInfo(msg);
      setGenerateMessage("");
      toast({
        variant: "destructive",
        title: t.errorProcessing,
        description: msg,
      });
    } finally {
      setIsGenerating(false);
      jobIdRef.current = null;
    }
  };

  const handleDownload = () => {
    if (!videoBlob) return;
    const url = URL.createObjectURL(videoBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `talking-character-ai-${Date.now()}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleLang = () => {
    const newLang = lang === "ar" ? "en" : "ar";
    setLang(newLang);
    document.documentElement.lang = newLang;
    document.documentElement.dir = newLang === "ar" ? "rtl" : "ltr";
  };

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      if (jobIdRef.current) cleanupJob(jobIdRef.current);
    };
  }, [videoUrl]);

  const status = !imageFile
    ? t.statusSelectCharacter
    : !audioFile
    ? t.statusSelectAudio
    : backendStatus !== "ok"
    ? (lang === "ar" ? "في انتظار السيرفر..." : "Waiting for backend...")
    : t.statusReady;

  const isRTL = lang === "ar";

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: "linear-gradient(135deg, #0a0b10 0%, #161820 50%, #1a1c25 100%)",
        direction: isRTL ? "rtl" : "ltr",
      }}
    >
      {/* Header */}
      <header className="border-b border-purple-500/20 backdrop-blur-md bg-black/20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-purple-300 to-pink-300 bg-clip-text text-transparent">
                {t.appTitle}
              </h1>
              <p className="text-xs text-gray-400 flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                {t.aiPoweredBy}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={`${
                backendStatus === "ok"
                  ? "border-green-500/50 text-green-300"
                  : backendStatus === "down"
                  ? "border-red-500/50 text-red-300"
                  : "border-yellow-500/50 text-yellow-300"
              }`}
            >
              {backendStatus === "ok" ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-green-500 mr-1 animate-pulse" />
                  AI {backendInfo?.device === "cuda" ? "GPU" : "CPU"}
                </>
              ) : backendStatus === "starting" ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  {lang === "ar" ? "تشغيل السيرفر..." : "Starting..."}
                </>
              ) : backendStatus === "down" ? (
                <>
                  <AlertCircle className="w-3 h-3 mr-1" />
                  {lang === "ar" ? "السيرفر مطفي" : "Backend down"}
                </>
              ) : (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  {lang === "ar" ? "فحص..." : "Checking..."}
                </>
              )}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleLang}
              className="border-purple-500/30 hover:bg-purple-500/10"
            >
              <Globe className="w-4 h-4 mr-2" />
              {lang === "ar" ? "English" : "عربي"}
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8 flex-1">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left: Controls */}
          <div className="lg:col-span-2 space-y-6 order-2 lg:order-1">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="grid grid-cols-3 mb-6 bg-black/30 border border-purple-500/20">
                <TabsTrigger value="character" className="data-[state=active]:bg-purple-500/30">
                  <Users className="w-4 h-4 mr-2" />
                  <span className="hidden sm:inline">{t.tabCharacter}</span>
                </TabsTrigger>
                <TabsTrigger value="voice" className="data-[state=active]:bg-purple-500/30">
                  <Music className="w-4 h-4 mr-2" />
                  <span className="hidden sm:inline">{t.tabVoice}</span>
                </TabsTrigger>
                <TabsTrigger value="preview" className="data-[state=active]:bg-purple-500/30">
                  <Play className="w-4 h-4 mr-2" />
                  <span className="hidden sm:inline">{t.tabPreview}</span>
                </TabsTrigger>
              </TabsList>

              {/* Character Tab */}
              <TabsContent value="character">
                <Card className="p-6 bg-black/30 border-purple-500/20">
                  <div className="mb-4">
                    <h3 className="text-lg font-semibold text-purple-200 mb-1">{t.sectionPresets}</h3>
                    <p className="text-sm text-gray-400">{t.presetDesc}</p>
                  </div>

                  <ScrollArea className="h-72 rounded-lg">
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 p-1">
                      {CHARACTER_FILES.map((file, i) => (
                        <button
                          key={i}
                          onClick={() => handleSelectCharacter(i)}
                          className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-all hover:scale-105 ${
                            selectedCharacter === i
                              ? "border-purple-500 ring-2 ring-purple-500/50"
                              : "border-transparent hover:border-purple-500/50"
                          }`}
                        >
                          <img
                            src={file}
                            alt={t.characters[i]}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                          {selectedCharacter === i && (
                            <div className="absolute inset-0 bg-purple-500/30 flex items-center justify-center">
                              <CheckCircle2 className="w-6 h-6 text-white" />
                            </div>
                          )}
                          <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] py-1 px-1 text-center">
                            #{i + 1}
                          </div>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>

                  <div className="mt-6 pt-6 border-t border-purple-500/10">
                    <h4 className="text-sm font-semibold text-purple-200 mb-2">{t.sectionUpload}</h4>
                    <label className="block">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleImageUpload}
                        className="hidden"
                      />
                      <div className="flex flex-col items-center justify-center border-2 border-dashed border-purple-500/30 rounded-lg p-6 cursor-pointer hover:border-purple-500/60 hover:bg-purple-500/5 transition-all">
                        <Upload className="w-8 h-8 text-purple-400 mb-2" />
                        <p className="text-sm text-purple-200">{t.uploadButton}</p>
                        <p className="text-xs text-gray-400 mt-1">{t.uploadHint}</p>
                      </div>
                    </label>
                  </div>
                </Card>
              </TabsContent>

              {/* Voice Tab */}
              <TabsContent value="voice">
                <Card className="p-6 bg-black/30 border-purple-500/20">
                  <div className="mb-4">
                    <h3 className="text-lg font-semibold text-purple-200 mb-1">{t.sectionVoice}</h3>
                    <p className="text-sm text-gray-400">{t.voiceHint}</p>
                  </div>

                  <label className="block">
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={handleAudioUpload}
                      className="hidden"
                    />
                    <div className="flex flex-col items-center justify-center border-2 border-dashed border-purple-500/30 rounded-lg p-8 cursor-pointer hover:border-purple-500/60 hover:bg-purple-500/5 transition-all">
                      <AudioLines className="w-10 h-10 text-purple-400 mb-3" />
                      <p className="text-sm text-purple-200">{t.voiceButton}</p>
                      <p className="text-xs text-gray-400 mt-1">{t.voiceHint}</p>
                    </div>
                  </label>

                  {audioBuffer && (
                    <AudioPreview audioBuffer={audioBuffer} fileName={audioFileName} duration={audioDuration} />
                  )}
                </Card>
              </TabsContent>

              {/* Preview Tab */}
              <TabsContent value="preview">
                <Card className="p-6 bg-black/30 border-purple-500/20">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-purple-200 flex items-center gap-2">
                      <Zap className="w-5 h-5 text-yellow-400" />
                      {t.tabPreview}
                    </h3>
                    {isGenerating && (
                      <Badge key="gen-badge" className="bg-purple-500/20 text-purple-200">
                        <span className="inline-flex items-center">
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          <span>{generateProgress}%</span>
                        </span>
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-4">
                    {/* AI Generation Button - prominent */}
                    <Button
                      onClick={handleGenerateAI}
                      disabled={isGenerating || !imageFile || !audioFile || backendStatus !== "ok"}
                      className="w-full bg-gradient-to-r from-yellow-500 via-purple-500 to-pink-500 hover:from-yellow-600 hover:via-purple-600 hover:to-pink-600 disabled:opacity-50 disabled:cursor-not-allowed"
                      size="lg"
                    >
                      {isGenerating ? (
                        <span key="generating" className="inline-flex items-center justify-center">
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          <span>{t.generating} {generateProgress}%</span>
                        </span>
                      ) : (
                        <span key="idle" className="inline-flex items-center justify-center">
                          <Sparkles className="w-4 h-4 mr-2" />
                          <span>{t.generateVideo}</span>
                        </span>
                      )}
                    </Button>

                    {isGenerating && (
                      <div className="space-y-2">
                        <Progress value={generateProgress} className="h-2" />
                        <p className="text-xs text-center text-purple-200">
                          {generateMessage || t.generating}
                        </p>
                        <p className="text-[10px] text-center text-gray-500">
                          {lang === "ar"
                            ? "الذكاء الاصطناعي بيتعلم بآلاف الأمثلة - استنى شوية"
                            : "AI is trained on thousands of examples - please wait"}
                        </p>
                      </div>
                    )}

                    {/* Warning if backend is down */}
                    {backendStatus === "down" && (
                      <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-200 text-sm flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-semibold">
                            {lang === "ar" ? "السيرفر مش شغال" : "Backend is down"}
                          </p>
                          <p className="text-xs mt-1">
                            {lang === "ar"
                              ? "شغّل الـ Wav2Lip backend على port 8000 بـ: cd backend && python3 server.py"
                              : "Start the Wav2Lip backend on port 8000: cd backend && python3 server.py"}
                          </p>
                        </div>
                      </div>
                    )}

                    {videoUrl && (
                      <div className="space-y-3 pt-4 border-t border-purple-500/20">
                        <video src={videoUrl} controls autoPlay loop className="w-full rounded-lg bg-black" />
                        <Button onClick={handleDownload} className="w-full bg-green-600 hover:bg-green-700">
                          <Download className="w-4 h-4 mr-2" />
                          {t.downloadVideo}
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* Right: Preview Canvas */}
          <div className="lg:col-span-1 order-1 lg:order-2">
            <Card className="p-4 bg-black/40 border-purple-500/20 lg:sticky lg:top-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-purple-200 flex items-center">
                  <Eye className="w-4 h-4 mr-2" />
                  {t.tabPreview}
                </h3>
                <Badge
                  variant="outline"
                  className={`${
                    videoUrl
                      ? "border-green-500/50 text-green-300"
                      : "border-purple-500/30 text-purple-300"
                  }`}
                >
                  {videoUrl ? "● AI VIDEO" : "○ IMAGE"}
                </Badge>
              </div>

              <div className="aspect-square rounded-lg overflow-hidden bg-black relative">
                {videoUrl ? (
                  <video src={videoUrl} controls autoPlay loop className="w-full h-full" />
                ) : (
                  <>
                    <canvas
                      ref={canvasRef}
                      width={720}
                      height={720}
                      className="w-full h-full"
                    />
                    {!imageReady && (
                      <div className="absolute inset-0 flex items-center justify-center text-center p-4">
                        <div>
                          <Sparkles className="w-12 h-12 mx-auto mb-3 text-purple-400/40" />
                          <p className="text-sm text-purple-200/60">{t.statusSelectCharacter}</p>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Status */}
              <div className="mt-4 p-3 rounded-lg bg-purple-500/5 border border-purple-500/20">
                <div className="flex items-center gap-2 mb-1">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      imageFile && audioFile && backendStatus === "ok"
                        ? "bg-green-500"
                        : "bg-yellow-500"
                    } animate-pulse`}
                  />
                  <span className="text-xs text-purple-200">{status}</span>
                </div>
                {audioFile && (
                  <div className="text-xs text-gray-400 mt-1">
                    {audioDuration.toFixed(1)}s · {audioFileName}
                  </div>
                )}
                {debugInfo && (
                  <div className="mt-2 text-xs text-yellow-300 border-t border-yellow-500/20 pt-2 break-words">
                    ⚠ {debugInfo}
                  </div>
                )}
              </div>

              {/* Selected character preview */}
              {(selectedCharacter !== null || uploadedImage) && (
                <div className="mt-3 p-2 rounded-lg bg-purple-500/5 border border-purple-500/20">
                  <p className="text-xs text-purple-200 mb-2">{t.selectedCharacter}</p>
                  <div className="flex items-center gap-2">
                    <img
                      src={uploadedImage || CHARACTER_FILES[selectedCharacter!]}
                      alt="Selected"
                      className="w-12 h-12 rounded-lg object-cover"
                    />
                    <span className="text-xs text-gray-300 truncate">
                      {selectedCharacter !== null
                        ? `#${selectedCharacter + 1} ${t.characters[selectedCharacter]}`
                        : (imageFile?.name || t.uploadButton)}
                    </span>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-purple-500/20 bg-black/20 py-6">
        <div className="container mx-auto px-4 text-center">
          <p className="text-xs text-gray-500">{t.footer}</p>
        </div>
      </footer>

      <Toaster />
    </div>
  );
}
