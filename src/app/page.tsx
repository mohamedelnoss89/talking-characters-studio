'use client';

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  Music,
  Play,
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
  Type,
  Volume2,
  User,
  Wand2,
  Image as ImageIcon,
  RefreshCw,
  Info,
} from "lucide-react";
import { translations, type Language } from "@/lib/i18n";
import { Toaster } from "@/components/ui/toaster";
import {
  startLipSync,
  pollJobUntilDone,
  downloadVideo,
  cleanupJob,
  listVoices,
  previewTts,
  generateCharacter,
  getCharacterOptions,
  base64ImageToFile,
  type LipSyncJobStatus,
  type TtsVoice,
  type CharacterStyle,
  type CharacterGender,
  type GeneratedCharacter,
} from "@/lib/wav2lip-client";

export default function Home() {
  const [lang, setLang] = useState<Language>("ar");
  const t = translations[lang];

  // Image state
  const [charMode, setCharMode] = useState<"upload" | "generate">("upload");
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageReady, setImageReady] = useState(false);

  // Character generation state
  const [charStyles, setCharStyles] = useState<CharacterStyle[]>([]);
  const [charGenders, setCharGenders] = useState<CharacterGender[]>([]);
  const [charPrompt, setCharPrompt] = useState<string>("");
  const [charStyle, setCharStyle] = useState<string>("realistic");
  const [charGender, setCharGender] = useState<string>("any");
  const [generatingChar, setGeneratingChar] = useState(false);
  const [genCharStep, setGenCharStep] = useState<string>("");
  const [generatedChar, setGeneratedChar] = useState<GeneratedCharacter | null>(null);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);

  // Audio/script state
  const [audioMode, setAudioMode] = useState<"script" | "audio">("script");
  const [scriptText, setScriptText] = useState<string>("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioFileName, setAudioFileName] = useState<string>("");
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);

  // Voices state
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("ar-EG-SalmaNeural");
  const [speechRate, setSpeechRate] = useState<string>("+0%");
  const [previewingTts, setPreviewingTts] = useState(false);
  const [ttsPreviewUrl, setTtsPreviewUrl] = useState<string | null>(null);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateProgress, setGenerateProgress] = useState(0);
  const [generateMessage, setGenerateMessage] = useState<string>("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("character");
  const [debugInfo, setDebugInfo] = useState<string>("");
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

  // === تحميل قائمة الأصوات + خيارات توليد الشخصيات ===
  useEffect(() => {
    listVoices().then((resp) => {
      if (resp.voices && resp.voices.length > 0) {
        setVoices(resp.voices);
        if (resp.default) setSelectedVoice(resp.default);
      }
    }).catch((e) => {
      console.warn("Failed to load voices:", e);
    });

    getCharacterOptions().then((opts) => {
      if (opts.styles?.length) setCharStyles(opts.styles);
      if (opts.genders?.length) setCharGenders(opts.genders);
    }).catch((e) => {
      console.warn("Failed to load char options:", e);
    });
  }, []);

  const loadImage = useCallback((src: string): Promise<HTMLImageElement> => {
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

  useEffect(() => {
    if (imageReady && !videoUrl) {
      drawPreview();
    }
  }, [imageReady, videoUrl, drawPreview]);

  // رفع صورة من الجهاز
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    setUploadedImage(url);
    setImageReady(false);
    setImageFile(file);
    setVideoBlob(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setDebugInfo("");

    // امسح أي شخصية مولّدة سابقة
    setGeneratedChar(null);
    if (generatedImageUrl) URL.revokeObjectURL(generatedImageUrl);
    setGeneratedImageUrl(null);

    try {
      const img = await loadImage(url);
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

  // === توليد شخصية جديدة بالـ AI ===
  const handleGenerateCharacter = async () => {
    const trimmed = charPrompt.trim();
    if (!trimmed) {
      toast({
        variant: "destructive",
        title: lang === "ar" ? "الوصف فاضي" : "Empty description",
        description: lang === "ar" ? "اكتب وصف للشخصية الأول" : "Describe a character first",
      });
      return;
    }
    if (trimmed.length > 1000) {
      toast({
        variant: "destructive",
        title: t.charPromptTooLong,
        description: `${trimmed.length} / 1000`,
      });
      return;
    }

    setGeneratingChar(true);
    setGenCharStep(t.generatingStep1);
    setGeneratedChar(null);
    if (generatedImageUrl) URL.revokeObjectURL(generatedImageUrl);
    setGeneratedImageUrl(null);
    setDebugInfo("");

    try {
      setGenCharStep(t.generatingStep1);
      // ده نداء واحد بس - بيشتغل sync على السيرفر
      const result = await generateCharacter({
        prompt: trimmed,
        style: charStyle,
        gender: charGender,
        language: lang,
      });
      setGenCharStep(t.generatingStep2);

      // حوّل base64 لـ object URL للمعاينة
      const cleaned = result.image_base64.replace(/^data:[^;]+;base64,/, "");
      const binary = atob(cleaned);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: result.image_mime || "image/png" });
      const url = URL.createObjectURL(blob);
      setGeneratedImageUrl(url);
      setGeneratedChar(result);

      toast({
        title: t.charSuccess,
        description: lang === "ar" ? "الصورة جاهزة - اضغط \"استخدم الصورة دي\" للمتابعة" : "Image ready - click Use to continue",
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      setDebugInfo(`${t.charError}: ${msg}`);
      toast({
        variant: "destructive",
        title: t.charError,
        description: msg,
      });
    } finally {
      setGeneratingChar(false);
      setGenCharStep("");
    }
  };

  // اعتمد الشخصية المولّدة كصورة فعّالة (حطّها في imageFile)
  const handleUseGeneratedCharacter = async () => {
    if (!generatedChar || !generatedImageUrl) return;

    // امسح أي video سابق
    setVideoBlob(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setDebugInfo("");

    // حوّل base64 لـ File
    const file = base64ImageToFile(
      generatedChar.image_base64,
      generatedChar.image_mime || "image/png",
      `ai-character-${Date.now()}.png`
    );
    setImageFile(file);

    try {
      const img = await loadImage(generatedImageUrl);
      imageRef.current = img;
      setUploadedImage(generatedImageUrl);
      setImageReady(true);
      toast({
        title: lang === "ar" ? "تم اعتماد الشخصية" : "Character selected",
        description: lang === "ar" ? "تقدر تكمل للصوت والفيديو دلوقتي" : "Proceed to voice & video",
      });
    } catch (e) {
      setDebugInfo(lang === "ar" ? "فشل تحميل صورة الشخصية" : "Failed to load generated image");
    }
  };

  // رفع ملف صوتي - مباشرة بدون AudioContext (أسرع وما بيقعش مع الصيغ المختلفة)
  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setAudioFileName(file.name);
    setAudioFile(file);
    setDebugInfo("");

    // امسح أي URL قديم
    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    // اعمل URL محلي للمعاينة (بدون decode - أسرع وما بيوقعش)
    const url = URL.createObjectURL(file);
    setAudioPreviewUrl(url);

    // احسب المدة باستخدام HTML5 audio (آمن ومش بيوقع)
    try {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.src = url;
      await new Promise<void>((resolve) => {
        audio.onloadedmetadata = () => resolve();
        audio.onerror = () => resolve();  // حتى لو فيه error، كمّل (الملف لسه موجود)
      });
      setAudioDuration(audio.duration && isFinite(audio.duration) ? audio.duration : 0);
    } catch {
      setAudioDuration(0);
    }

    toast({
      title: lang === "ar" ? "تم رفع الصوت" : "Audio Uploaded",
      description: `${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
    });
  };

  // معاينة TTS
  const handlePreviewTts = async () => {
    if (!scriptText.trim()) {
      toast({
        variant: "destructive",
        title: lang === "ar" ? "نص فاضي" : "Empty script",
        description: lang === "ar" ? "اكتب نص الأول" : "Write some text first",
      });
      return;
    }
    setPreviewingTts(true);
    if (ttsPreviewUrl) {
      URL.revokeObjectURL(ttsPreviewUrl);
      setTtsPreviewUrl(null);
    }
    try {
      const blob = await previewTts(scriptText, selectedVoice, speechRate);
      const url = URL.createObjectURL(blob);
      setTtsPreviewUrl(url);
      toast({
        title: lang === "ar" ? "تم توليد المعاينة" : "Preview ready",
        description: `${(blob.size / 1024).toFixed(1)} KB · ${selectedVoice}`,
      });
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: lang === "ar" ? "خطأ في TTS" : "TTS Error",
        description: e?.message || String(e),
      });
    } finally {
      setPreviewingTts(false);
    }
  };

  // === توليد الفيديو ===
  const handleGenerateAI = async () => {
    setDebugInfo("");
    if (!imageFile) {
      const msg = lang === "ar" ? "ارفع صورة الأول" : "Upload an image first";
      setDebugInfo(msg);
      toast({
        variant: "destructive",
        title: lang === "ar" ? "بيانات ناقصة" : "Missing Data",
        description: msg,
      });
      setActiveTab("character");
      return;
    }

    const hasAudio = !!audioFile;
    const hasScript = !!scriptText.trim();
    if (!hasAudio && !hasScript) {
      const msg = lang === "ar"
        ? "ارفع ملف صوتي أو اكتب سكربت الأول"
        : "Upload audio or write a script first";
      setDebugInfo(msg);
      toast({
        variant: "destructive",
        title: lang === "ar" ? "بيانات ناقصة" : "Missing Data",
        description: msg,
      });
      setActiveTab("voice");
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

    requestAnimationFrame(() => setActiveTab("preview"));

    try {
      // 1. ابدأ الـ job
      setGenerateMessage(
        audioMode === "script"
          ? (lang === "ar" ? "بتوليد الصوت من السكربت..." : "Generating audio from script...")
          : (lang === "ar" ? "بتقديم الطلب للـ AI..." : "Submitting to AI...")
      );
      const { job_id } = await startLipSync(imageFile, {
        audioFile: audioMode === "audio" ? audioFile : null,
        scriptText: audioMode === "script" ? scriptText : undefined,
        voice: selectedVoice,
        rate: speechRate,
        imageName: imageFile.name || "character.png",
        audioName: audioFile?.name || "audio.wav",
        pads: "0,10,0,0",
        resizeFactor: 1,
      });
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
        240
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
      if (ttsPreviewUrl) URL.revokeObjectURL(ttsPreviewUrl);
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
      if (generatedImageUrl) URL.revokeObjectURL(generatedImageUrl);
      if (jobIdRef.current) cleanupJob(jobIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasInput = imageFile && (audioFile || scriptText.trim());
  const status = !imageFile
    ? t.statusSelectCharacter
    : !audioFile && !scriptText.trim()
    ? t.statusSelectAudio
    : backendStatus !== "ok"
    ? (lang === "ar" ? "في انتظار السيرفر..." : "Waiting for backend...")
    : t.statusReady;

  const isRTL = lang === "ar";
  const selectedVoiceObj = voices.find((v) => v.id === selectedVoice);
  const scriptChars = scriptText.length;
  const rateOptions = [
    { value: "-15%", label: t.speedSlow },
    { value: "+0%", label: t.speedNormal },
    { value: "+15%", label: t.speedFast },
  ];

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
              <p className="text-xs text-gray-300 flex items-center gap-1">
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
                  <User className="w-4 h-4 mr-2" />
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

              {/* Character Tab - upload OR generate */}
              <TabsContent value="character">
                <Card className="p-6 bg-black/30 border-purple-500/20">
                  {/* Mode switch */}
                  <div className="mb-6">
                    <Label className="text-xs text-gray-300 mb-2 block">{t.charModeLabel}</Label>
                    <div className="grid grid-cols-2 gap-2 p-1 bg-black/30 rounded-lg border border-purple-500/20">
                      <button
                        type="button"
                        onClick={() => setCharMode("upload")}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                          charMode === "upload"
                            ? "bg-purple-500/30 text-purple-100 border border-purple-500/50"
                            : "text-gray-200 hover:text-purple-100"
                        }`}
                      >
                        <Upload className="w-4 h-4" />
                        {t.charModeUpload}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCharMode("generate")}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                          charMode === "generate"
                            ? "bg-gradient-to-r from-purple-500/30 to-pink-500/30 text-purple-100 border border-pink-500/50"
                            : "text-gray-200 hover:text-purple-100"
                        }`}
                      >
                        <Wand2 className="w-4 h-4" />
                        {t.charModeGenerate}
                      </button>
                    </div>
                  </div>

                  {/* === Upload mode === */}
                  {charMode === "upload" && (
                    <>
                      <div className="mb-4">
                        <h3 className="text-lg font-semibold text-purple-200 mb-1">{t.sectionUpload}</h3>
                        <p className="text-sm text-gray-300">{t.uploadHint}</p>
                      </div>

                      <label className="block">
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleImageUpload}
                          className="hidden"
                        />
                        <div className="flex flex-col items-center justify-center border-2 border-dashed border-purple-500/30 rounded-lg p-10 cursor-pointer hover:border-purple-500/60 hover:bg-purple-500/5 transition-all">
                          <Upload className="w-12 h-12 text-purple-400 mb-3" />
                          <p className="text-base text-purple-200">{t.uploadButton}</p>
                          <p className="text-xs text-gray-300 mt-1">{t.uploadHint}</p>
                        </div>
                      </label>

                      {imageFile && (
                        <div className="mt-4 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center gap-3">
                          <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-purple-100 truncate">{imageFile.name}</p>
                            <p className="text-xs text-gray-300">
                              {(imageFile.size / 1024).toFixed(1)} KB
                            </p>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* === Generate mode === */}
                  {charMode === "generate" && (
                    <>
                      <div className="mb-4">
                        <h3 className="text-lg font-semibold text-transparent bg-clip-text bg-gradient-to-r from-purple-300 to-pink-300 mb-1 flex items-center gap-2">
                          <Wand2 className="w-5 h-5 text-pink-400" />
                          {t.sectionGenerate}
                        </h3>
                        <p className="text-sm text-gray-300">{t.generateHint}</p>
                      </div>

                      {/* Prompt input */}
                      <div className="mb-4">
                        <div className="flex items-center justify-between mb-2">
                          <Label className="text-sm text-purple-200 flex items-center gap-2">
                            <Type className="w-4 h-4" />
                            {t.charPromptLabel}
                          </Label>
                          <Badge variant="outline" className="text-xs">
                            {charPrompt.length} {t.charPromptChars}
                          </Badge>
                        </div>
                        <textarea
                          value={charPrompt}
                          onChange={(e) => setCharPrompt(e.target.value.slice(0, 1000))}
                          placeholder={t.charPromptPlaceholder}
                          rows={4}
                          className="w-full px-3 py-2 rounded-lg bg-black/40 border border-purple-500/30 text-purple-100 placeholder-gray-400 focus:outline-none focus:border-pink-500/60 resize-y text-sm leading-relaxed"
                          dir={isRTL ? "rtl" : "ltr"}
                        />

                        {/* Quick ideas */}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(lang === "ar"
                            ? [
                                "رجل أعمال عربي شاب بنظارة وبدلة",
                                "سيدة عربية في الأربعينات بابتسامة دافئة",
                                "شاب خليجي بلحية مدروسة وغترة",
                                "فتاة بشارب أسود وعيون خضراء",
                                "شخصية كرتونية لطفل فضولي",
                                "رجل مسؤول كبير في الستينات بهيئة وقور",
                              ]
                            : [
                                "young Arab businessman with glasses and suit",
                                "Arab woman in her 40s with warm smile",
                                "Gulf young man with neat beard and gutra",
                                "girl with black hair and green eyes",
                                "cartoon character of a curious child",
                                "dignified senior official in his 60s",
                              ]
                          ).map((idea, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setCharPrompt(idea)}
                              className="px-2 py-1 rounded-md text-xs bg-black/40 border border-purple-500/20 text-purple-200 hover:border-pink-500/40 hover:text-pink-200 transition-all"
                            >
                              {idea}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Style + Gender selectors */}
                      <div className="grid grid-cols-2 gap-3 mb-5">
                        <div>
                          <Label className="text-sm text-purple-200 mb-2 block flex items-center gap-2">
                            <ImageIcon className="w-4 h-4" />
                            {t.charStyleLabel}
                          </Label>
                          <Select value={charStyle} onValueChange={setCharStyle}>
                            <SelectTrigger className="bg-black/40 border-purple-500/30 text-purple-100">
                              <SelectValue placeholder={t.charStyleLabel} />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-900 border-purple-500/30">
                              {(charStyles.length > 0
                                ? charStyles
                                : [
                                    { id: "realistic", label: t.charStyleRealistic },
                                    { id: "anime", label: t.charStyleAnime },
                                    { id: "cartoon", label: t.charStyleCartoon },
                                    { id: "3d", label: t.charStyle3d },
                                    { id: "oil", label: t.charStyleOil },
                                    { id: "watercolor", label: t.charStyleWatercolor },
                                  ]
                              ).map((s) => (
                                <SelectItem key={s.id} value={s.id}>
                                  {s.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-sm text-purple-200 mb-2 block flex items-center gap-2">
                            <User className="w-4 h-4" />
                            {t.charGenderLabel}
                          </Label>
                          <Select value={charGender} onValueChange={setCharGender}>
                            <SelectTrigger className="bg-black/40 border-purple-500/30 text-purple-100">
                              <SelectValue placeholder={t.charGenderLabel} />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-900 border-purple-500/30">
                              {(charGenders.length > 0
                                ? charGenders
                                : [
                                    { id: "any", label_ar: t.charGenderAny, label_en: t.charGenderAny },
                                    { id: "male", label_ar: t.charGenderMale, label_en: t.charGenderMale },
                                    { id: "female", label_ar: t.charGenderFemale, label_en: t.charGenderFemale },
                                  ]
                              ).map((g) => (
                                <SelectItem key={g.id} value={g.id}>
                                  {lang === "ar" ? g.label_ar : g.label_en}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {/* Generate button */}
                      <Button
                        onClick={handleGenerateCharacter}
                        disabled={generatingChar || !charPrompt.trim()}
                        className="w-full bg-gradient-to-r from-purple-500 via-pink-500 to-yellow-500 hover:from-purple-600 hover:via-pink-600 hover:to-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed"
                        size="lg"
                      >
                        {generatingChar ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            {t.generatingCharacter}
                          </>
                        ) : (
                          <>
                            <Wand2 className="w-4 h-4 mr-2" />
                            {t.generateCharacterBtn}
                          </>
                        )}
                      </Button>

                      {/* Progress / step indicator */}
                      {generatingChar && genCharStep && (
                        <div className="mt-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                          <div className="flex items-center gap-2 text-sm text-purple-100">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>{genCharStep}</span>
                          </div>
                          <p className="text-[10px] text-gray-400 mt-1">
                            {lang === "ar"
                              ? "الـ AI بيرسم الشخصية - ده بياخد 15-30 ثانية"
                              : "AI is drawing the character - takes 15-30 seconds"}
                          </p>
                        </div>
                      )}

                      {/* Generated image + description */}
                      {generatedChar && generatedImageUrl && !generatingChar && (
                        <div className="mt-4 space-y-3">
                          <div className="aspect-square rounded-lg overflow-hidden bg-black border border-pink-500/30 relative">
                            <img
                              src={generatedImageUrl}
                              alt="Generated character"
                              className="w-full h-full object-contain"
                            />
                            <div className="absolute top-2 right-2 px-2 py-1 rounded-md bg-black/70 backdrop-blur-sm border border-pink-500/30">
                              <span className="text-[10px] font-bold text-pink-300 flex items-center gap-1">
                                <Sparkles className="w-3 h-3" />
                                AI GENERATED
                              </span>
                            </div>
                          </div>

                          {/* Description */}
                          <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                            <div className="flex items-center gap-2 mb-2">
                              <Info className="w-4 h-4 text-purple-300" />
                              <span className="text-sm font-semibold text-purple-100">
                                {t.charDescriptionTitle}
                              </span>
                            </div>
                            <p
                              className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap"
                              dir={isRTL ? "rtl" : "ltr"}
                            >
                              {lang === "ar"
                                ? generatedChar.description_ar || generatedChar.description_en
                                : generatedChar.description_en || generatedChar.description_ar}
                            </p>
                            {generatedChar.prompt_used && (
                              <details className="mt-2">
                                <summary className="text-xs text-purple-300 cursor-pointer hover:text-purple-200">
                                  {t.charPromptUsed}
                                </summary>
                                <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                                  {generatedChar.prompt_used}
                                </p>
                              </details>
                            )}
                          </div>

                          {/* Action buttons */}
                          <div className="grid grid-cols-2 gap-2">
                            <Button
                              onClick={handleGenerateCharacter}
                              variant="outline"
                              className="border-purple-500/30 hover:bg-purple-500/10"
                            >
                              <RefreshCw className="w-4 h-4 mr-2" />
                              {t.charRegenerate}
                            </Button>
                            <Button
                              onClick={handleUseGeneratedCharacter}
                              className="bg-green-600 hover:bg-green-700"
                            >
                              <CheckCircle2 className="w-4 h-4 mr-2" />
                              {t.charUseThis}
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Active selected file (after Use) */}
                      {imageFile && generatedChar && (
                        <div className="mt-3 p-3 rounded-lg bg-green-500/10 border border-green-500/30 flex items-center gap-3">
                          <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-green-100 truncate">{imageFile.name}</p>
                            <p className="text-xs text-gray-300">
                              {(imageFile.size / 1024).toFixed(1)} KB · {lang === "ar" ? "جاهز للمتابعة" : "ready"}
                            </p>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </Card>
              </TabsContent>

              {/* Voice Tab */}
              <TabsContent value="voice">
                <Card className="p-6 bg-black/30 border-purple-500/20">
                  <div className="mb-4">
                    <h3 className="text-lg font-semibold text-purple-200 mb-1">{t.sectionVoice}</h3>
                    <p className="text-sm text-gray-300">{t.voiceSelectHint}</p>
                  </div>

                  {/* Mode switch */}
                  <div className="mb-6">
                    <Label className="text-xs text-gray-300 mb-2 block">{t.audioScriptTabs}</Label>
                    <div className="grid grid-cols-2 gap-2 p-1 bg-black/30 rounded-lg border border-purple-500/20">
                      <button
                        type="button"
                        onClick={() => setAudioMode("script")}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                          audioMode === "script"
                            ? "bg-purple-500/30 text-purple-100 border border-purple-500/50"
                            : "text-gray-200 hover:text-purple-100"
                        }`}
                      >
                        <Type className="w-4 h-4" />
                        {t.scriptMode}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAudioMode("audio")}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                          audioMode === "audio"
                            ? "bg-purple-500/30 text-purple-100 border border-purple-500/50"
                            : "text-gray-200 hover:text-purple-100"
                        }`}
                      >
                        <AudioLines className="w-4 h-4" />
                        {t.audioMode}
                      </button>
                    </div>
                  </div>

                  {/* Voice selector - visible in script mode */}
                  {audioMode === "script" && (
                    <>
                      <div className="mb-5">
                        <Label className="text-sm text-purple-200 mb-2 block flex items-center gap-2">
                          <Volume2 className="w-4 h-4" />
                          {t.sectionVoiceSelect}
                        </Label>
                        <Select value={selectedVoice} onValueChange={setSelectedVoice}>
                          <SelectTrigger className="bg-black/40 border-purple-500/30 text-purple-100">
                            <SelectValue placeholder={t.sectionVoiceSelect} />
                          </SelectTrigger>
                          <SelectContent className="bg-slate-900 border-purple-500/30 max-h-80">
                            {voices.length === 0 ? (
                              <SelectItem value="ar-EG-SalmaNeural">
                                {lang === "ar" ? "سلمى (مصر - أنثى)" : "Salma (Egypt - Female)"}
                              </SelectItem>
                            ) : (
                              voices.map((v) => (
                                <SelectItem key={v.id} value={v.id}>
                                  <span className="flex items-center gap-2">
                                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                                      v.gender === "Female"
                                        ? "bg-pink-500/20 text-pink-300"
                                        : "bg-blue-500/20 text-blue-300"
                                    }`}>
                                      {v.gender === "Female" ? "♀" : "♂"}
                                    </span>
                                    {lang === "ar" ? v.label_ar : v.label_en}
                                  </span>
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Speech rate */}
                      <div className="mb-5">
                        <Label className="text-sm text-purple-200 mb-2 block">{t.speedLabel}</Label>
                        <div className="grid grid-cols-3 gap-2">
                          {rateOptions.map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => setSpeechRate(opt.value)}
                              className={`px-3 py-2 rounded-md text-sm transition-all ${
                                speechRate === opt.value
                                  ? "bg-purple-500/30 text-purple-100 border border-purple-500/50"
                                  : "bg-black/30 text-gray-200 border border-transparent hover:border-purple-500/30"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Script input */}
                      <div className="mb-4">
                        <div className="flex items-center justify-between mb-2">
                          <Label className="text-sm text-purple-200 flex items-center gap-2">
                            <Type className="w-4 h-4" />
                            {t.sectionScript}
                          </Label>
                          <Badge variant="outline" className="text-xs">
                            {scriptChars} {t.scriptCharsCount}
                          </Badge>
                        </div>
                        <textarea
                          value={scriptText}
                          onChange={(e) => setScriptText(e.target.value.slice(0, 5000))}
                          placeholder={t.scriptPlaceholder}
                          rows={6}
                          className="w-full px-3 py-2 rounded-lg bg-black/40 border border-purple-500/30 text-purple-100 placeholder-gray-400 focus:outline-none focus:border-purple-500/60 resize-y text-sm leading-relaxed"
                          dir={isRTL ? "rtl" : "ltr"}
                        />
                        <p className="text-xs text-gray-300 mt-1">{t.scriptHint}</p>
                      </div>

                      {/* Preview TTS */}
                      <Button
                        type="button"
                        onClick={handlePreviewTts}
                        disabled={previewingTts || !scriptText.trim() || backendStatus !== "ok"}
                        variant="outline"
                        className="w-full border-purple-500/30 hover:bg-purple-500/10"
                      >
                        {previewingTts ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            {t.previewing}
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-4 h-4 mr-2" />
                            {t.previewVoice}
                          </>
                        )}
                      </Button>

                      {ttsPreviewUrl && (
                        <div className="mt-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                          <div className="flex items-center gap-2 mb-2">
                            <Music className="w-4 h-4 text-purple-300" />
                            <span className="text-sm text-purple-100">
                              {selectedVoiceObj
                                ? (lang === "ar" ? selectedVoiceObj.label_ar : selectedVoiceObj.label_en)
                                : selectedVoice}
                            </span>
                          </div>
                          <audio controls autoPlay src={ttsPreviewUrl} className="w-full h-8" />
                        </div>
                      )}
                    </>
                  )}

                  {/* Audio file upload mode */}
                  {audioMode === "audio" && (
                    <>
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
                          <p className="text-xs text-gray-300 mt-1">{t.voiceHint}</p>
                        </div>
                      </label>

                      {audioPreviewUrl && (
                        <div className="mt-4 p-4 rounded-lg bg-purple-500/10 border border-purple-500/20">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Music className="w-4 h-4 text-purple-300" />
                              <span className="text-sm text-purple-100 truncate max-w-[200px]">{audioFileName}</span>
                            </div>
                            {audioDuration > 0 && (
                              <Badge variant="secondary" className="bg-purple-500/20 text-purple-200">
                                {audioDuration.toFixed(1)}s
                              </Badge>
                            )}
                          </div>
                          <audio controls src={audioPreviewUrl} className="w-full h-8" />
                        </div>
                      )}
                    </>
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
                      <Badge className="bg-purple-500/20 text-purple-200">
                        <span className="inline-flex items-center">
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          <span>{generateProgress}%</span>
                        </span>
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-4">
                    <Button
                      onClick={handleGenerateAI}
                      disabled={isGenerating || !hasInput || backendStatus !== "ok"}
                      className="w-full bg-gradient-to-r from-yellow-500 via-purple-500 to-pink-500 hover:from-yellow-600 hover:via-purple-600 hover:to-pink-600 disabled:opacity-50 disabled:cursor-not-allowed"
                      size="lg"
                    >
                      <span className="inline-flex items-center justify-center">
                        {isGenerating ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4 mr-2" />
                        )}
                        <span>{isGenerating ? `${t.generating} ${generateProgress}%` : t.generateVideo}</span>
                      </span>
                    </Button>

                    {isGenerating && (
                      <div className="space-y-2">
                        <Progress value={generateProgress} className="h-2" />
                        <p className="text-xs text-center text-purple-200">
                          {generateMessage || t.generating}
                        </p>
                        <p className="text-[10px] text-center text-gray-400">
                          {lang === "ar"
                            ? "الذكاء الاصطناعي بيتعلم بآلاف الأمثلة - استنى شوية"
                            : "AI is trained on thousands of examples - please wait"}
                        </p>
                      </div>
                    )}

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
                      hasInput && backendStatus === "ok"
                        ? "bg-green-500"
                        : "bg-yellow-500"
                    } animate-pulse`}
                  />
                  <span className="text-xs text-purple-200">{status}</span>
                </div>
                {(audioFile || scriptText) && (
                  <div className="text-xs text-gray-300 mt-1">
                    {audioMode === "audio" && audioFile
                      ? `${audioDuration.toFixed(1)}s · ${audioFileName}`
                      : audioMode === "script" && scriptText
                      ? `${scriptText.length} ${t.scriptCharsCount} · ${selectedVoiceObj?.name || selectedVoice}`
                      : null}
                  </div>
                )}
                {debugInfo && (
                  <div className="mt-2 text-xs text-yellow-300 border-t border-yellow-500/20 pt-2 break-words">
                    ⚠ {debugInfo}
                  </div>
                )}
              </div>

              {/* Selected image preview */}
              {uploadedImage && (
                <div className="mt-3 p-2 rounded-lg bg-purple-500/5 border border-purple-500/20">
                  <p className="text-xs text-purple-200 mb-2">{t.selectedCharacter}</p>
                  <div className="flex items-center gap-2">
                    <img
                      src={uploadedImage}
                      alt="Selected"
                      className="w-12 h-12 rounded-lg object-cover"
                    />
                    <span className="text-xs text-gray-300 truncate">
                      {imageFile?.name || t.uploadButton}
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
          <p className="text-xs text-gray-400">{t.footer}</p>
        </div>
      </footer>

      <Toaster />
    </div>
  );
}
