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
  Users,
  Plus,
  Trash2,
  Wand2,
  Image as ImageIcon,
  RefreshCw,
  Info,
  LogOut,
  ChevronDown,
} from "lucide-react";
import { translations, type Language } from "@/lib/i18n";
import { Toaster } from "@/components/ui/toaster";
import PWAGuard from "@/components/PWAGuard";
import {
  startLipSync,
  startMultiLipSync,
  pollJobUntilDone,
  downloadVideo,
  cleanupJob,
  listVoices,
  previewTts,
  generateCharacter,
  getCharacterOptions,
  base64ImageToFile,
  detectFaces,
  preflightBackendCheck,
  isBackendReachable,
  restartDesktopBackend,
  type LipSyncJobStatus,
  type MultiScriptEntry,
  type TtsVoice,
  type CharacterStyle,
  type CharacterGender,
  type GeneratedCharacter,
  type DetectedFace,
  editCharacter,
} from "@/lib/wav2lip-client";
import { UpdateBanner } from "@/components/UpdateBanner";
import { BackendRestartButton } from "@/components/BackendRestartButton";

// ============================================================
// FaceSelector — Component لاختيار الوجه اللي هيتكلم
// بيعرض الصورة مع boxes حول كل وجه، والمستخدم بيدوس على الوجه اللي عاوزه.
// ============================================================
type FaceSelectorProps = {
  imageSrc: string | null;
  imageNaturalSize: { w: number; h: number } | null;
  detectedFaces: DetectedFace[];
  selectedFaceIndex: number;
  detecting: boolean;
  error: string;
  onSelect: (idx: number) => void;
  lang: Language;
  t: (typeof translations)[Language];
};

function FaceSelector({
  imageSrc,
  imageNaturalSize,
  detectedFaces,
  selectedFaceIndex,
  detecting,
  error,
  onSelect,
  lang,
  t,
}: FaceSelectorProps) {
  // لو مفيش صورة، ما نظهرش حاجة
  if (!imageSrc) return null;

  // لو لسه بيكتشف الوجوه، اعرض spinner
  if (detecting) {
    return (
      <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center gap-2 text-sm text-purple-100">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>{t.faceDetecting}</span>
      </div>
    );
  }

  // لو فيه خطأ في الكشف (مفيش وجوه أو فشل)، اعرض رسالة صغيرة بس ميمنعش التوليد
  if (error || detectedFaces.length === 0) {
    // اعرض رسالة بس لو فيه error حقيقي (مفيش وجوه)
    if (error) {
      return (
        <div className="p-2 rounded-md bg-yellow-500/5 border border-yellow-500/20 text-xs text-yellow-200/70">
          {error}
        </div>
      );
    }
    return null;
  }

  // لو فيه وجه واحد بس، اعرض رسالة صغيرة إنه اتحكش تلقائياً (ما نطلبش من المستخدم يعمل حاجة)
  if (detectedFaces.length === 1) {
    return (
      <div className="p-2 rounded-md bg-green-500/5 border border-green-500/20 text-xs text-green-200/70 flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>{t.faceSingleDetected}</span>
      </div>
    );
  }

  // لو فيه أكتر من وجه، اعرض الصورة بـ boxes قابلة للضغط
  return (
    <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30 space-y-2">
      <div className="flex items-center gap-2">
        <User className="w-4 h-4 text-purple-300" />
        <span className="text-sm font-semibold text-purple-100">{t.faceSelectTitle}</span>
      </div>
      <p className="text-xs text-purple-200/70">{t.faceSelectHint}</p>

      {/* الصورة مع boxes */}
      <div className="relative rounded-md overflow-hidden bg-black border border-purple-500/20">
        {/* نعرض الصورة بـ max-width ونخليها قابلة للضغط */}
        <div style={{ position: "relative", maxWidth: "400px", margin: "0 auto" }}>
          <img
            src={imageSrc}
            alt="Face selection"
            style={{ display: "block", width: "100%", height: "auto" }}
          />
          {/* boxes الوجوه */}
          {detectedFaces.map((face) => {
            // bbox = [x1, y1, x2, y2] بالـ pixels بالنسبة للصورة الأصلية
            // نحولها لنسب مئوية عشان تتعامل مع أي حجم عرض
            const natW = imageNaturalSize?.w || 1;
            const natH = imageNaturalSize?.h || 1;
            const left = (face.bbox[0] / natW) * 100;
            const top = (face.bbox[1] / natH) * 100;
            const width = ((face.bbox[2] - face.bbox[0]) / natW) * 100;
            const height = ((face.bbox[3] - face.bbox[1]) / natH) * 100;
            const isSelected = selectedFaceIndex === face.index;

            return (
              <button
                key={face.index}
                type="button"
                onClick={() => onSelect(face.index)}
                title={`${t.faceNumber} ${face.index + 1}`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                  border: isSelected
                    ? "3px solid #22c55e"
                    : "2px dashed rgba(236, 72, 153, 0.8)",
                  background: isSelected
                    ? "rgba(34, 197, 94, 0.15)"
                    : "rgba(236, 72, 153, 0.05)",
                  cursor: "pointer",
                  borderRadius: "4px",
                  transition: "all 0.15s ease",
                  padding: 0,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = "rgba(236, 72, 153, 0.15)";
                    e.currentTarget.style.border = "2px solid rgba(236, 72, 153, 1)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = "rgba(236, 72, 153, 0.05)";
                    e.currentTarget.style.border = "2px dashed rgba(236, 72, 153, 0.8)";
                  }
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: "-20px",
                    left: "0",
                    background: isSelected ? "#22c55e" : "rgba(236, 72, 153, 0.9)",
                    color: "white",
                    fontSize: "10px",
                    fontWeight: "bold",
                    padding: "1px 5px",
                    borderRadius: "3px",
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                  }}
                >
                  {t.faceNumber} {face.index + 1}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* زرار "تلقائي" */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => onSelect(-1)}
          className={`px-3 py-1 rounded-md text-xs border transition-all ${
            selectedFaceIndex === -1
              ? "bg-purple-500/30 border-purple-400 text-purple-100"
              : "bg-black/40 border-purple-500/20 text-purple-200 hover:border-purple-400"
          }`}
        >
          {t.faceAutoLabel}
        </button>
        {detectedFaces.map((face) => (
          <button
            key={face.index}
            type="button"
            onClick={() => onSelect(face.index)}
            className={`px-3 py-1 rounded-md text-xs border transition-all ${
              selectedFaceIndex === face.index
                ? "bg-green-600/30 border-green-400 text-green-100"
                : "bg-black/40 border-purple-500/20 text-purple-200 hover:border-green-400"
            }`}
          >
            {t.faceNumber} {face.index + 1}
          </button>
        ))}
        {selectedFaceIndex >= 0 && (
          <span className="text-xs text-green-200/70 ms-auto">
            ✓ {t.faceSelectedLabel}: {t.faceNumber} {selectedFaceIndex + 1}
          </span>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <PWAGuard>
      <HomeInner />
    </PWAGuard>
  );
}

function HomeInner() {
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

  // Image editing state (AI image-to-image)
  const [editPrompt, setEditPrompt] = useState("");
  const [editingChar, setEditingChar] = useState(false);
  const [editStep, setEditStep] = useState("");
  const [editProgress, setEditProgress] = useState(0);
  const [editElapsed, setEditElapsed] = useState(0);
  const [showEditBox, setShowEditBox] = useState(false);

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

  // === Multi-speaker state ===
  // speakerMode: "single" = المتحدث الواحد (السلوك الأصلي)
  //               "multi"   = حوار بين الشخصيات (كل وجه يقول سيناريو مختلف)
  const [speakerMode, setSpeakerMode] = useState<"single" | "multi">("single");
  // كل entry: { face_index, text, voice, rate }
  // بنستخدم default voice/rate من selectedVoice و speechRate
  type MultiSegment = { face_index: number; text: string; voice: string; rate: string };
  const [multiSegments, setMultiSegments] = useState<MultiSegment[]>([]);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateProgress, setGenerateProgress] = useState(0);
  const [generateMessage, setGenerateMessage] = useState<string>("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("character");
  const [debugInfo, setDebugInfo] = useState<string>("");
  const [backendStatus, setBackendStatus] = useState<"checking" | "ok" | "down" | "starting">("checking");
  const [backendInfo, setBackendInfo] = useState<{ device: string; model_loaded: boolean; wav2lip_available?: boolean } | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // Face detection state (for multi-face images)
  const [detectedFaces, setDetectedFaces] = useState<DetectedFace[]>([]);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number>(-1); // -1 = تلقائي
  const [detectingFaces, setDetectingFaces] = useState(false);
  const [faceDetectError, setFaceDetectError] = useState<string>("");
  const [imageNaturalSize, setImageNaturalSize] = useState<{w: number; h: number} | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const jobIdRef = useRef<string | null>(null);
  // ref عشان نتجنّب إعادة كشف الوجوه لنفس الصورة — كان بيتعمل كل ما backendStatus يتغير
  const lastDetectedFileKeyRef = useRef<string | null>(null);
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
          setBackendInfo({ device: health.device, model_loaded: health.model_loaded, wav2lip_available: health.wav2lip_available });
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

  // === فحص المستخدم الحالي (لعرض اسمه + زرار الخروج) ===
  useEffect(() => {
    fetch("/api/login", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data?.authenticated) {
          // Show only the display name in the header — email is NOT shown.
          setCurrentUser(
            data.displayName || data.username || (lang === "ar" ? "حسابي" : "My account")
          );
        }
      })
      .catch(() => {});
  }, [lang]);

  // === تسجيل الخروج ===
  const handleLogout = async (e?: React.MouseEvent) => {
    // Prevent any parent handler (e.g. the outside-click mousedown listener)
    // from swallowing the click before our fetch runs.
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (loggingOut) return; // already in progress — ignore double-clicks
    setLoggingOut(true);
    setUserMenuOpen(false);
    try {
      // Use keepalive so the request survives even if the page navigates
      await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
      });
    } catch (err) {
      // ignore — we'll redirect to /login anyway, which clears the UI session
    } finally {
      setCurrentUser(null);
      // Hard reload to /login to clear all client state
      window.location.assign("/login");
    }
  };

  // === إغلاق قائمة المستخدم لما يدوس برّه ===
  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-user-menu]")) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [userMenuOpen]);

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
  }, [imageReady, videoUrl, drawPreview, generatedChar]);

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

    // امسح أي شخصية مولّدة سابقة + أي كشف وجوه سابق
    setGeneratedChar(null);
    if (generatedImageUrl) URL.revokeObjectURL(generatedImageUrl);
    setGeneratedImageUrl(null);
    setDetectedFaces([]);
    setSelectedFaceIndex(-1);
    setFaceDetectError("");

    try {
      const img = await loadImage(url);
      imageRef.current = img;
      setImageNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
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
      // Pre-flight: تأكد إن الـ backend شغال قبل ما نبدأ (يستنى 1-3 دقايق
      // لو الـ app لسه بتحمّل النماذج). ده بيمنع الـ "AI is slow" message
      // المضللة لما السيرفر يكون لسه بيبدأ.
      const preflightErr = await preflightBackendCheck(lang);
      if (preflightErr) {
        throw Object.assign(new Error(preflightErr), { error_type: "backend_unavailable" });
      }

      setGenCharStep(t.generatingStep1);
      // job-based: POST يبدأ الشغل، poll كل 2s — كده الـ ALB مش بيتقطع
      const result = await generateCharacter({
        prompt: trimmed,
        style: charStyle,
        gender: charGender,
        language: lang,
      }, (progress, message, elapsedSec) => {
        if (message) setGenCharStep(message);
        if (typeof elapsedSec === "number") {
          setDebugInfo(lang === "ar" ? `الوقت: ${elapsedSec}s` : `Elapsed: ${elapsedSec}s`);
        }
      });

      // Sanity check: الـ response لازم يكون فيه image_base64
      if (!result.image_base64 || result.image_base64.length < 1000) {
        throw new Error(
          result.error || (lang === "ar"
            ? "الـ AI رجّع صورة فاضية - حاول تاني بوصف مختلف"
            : "AI returned empty image - try again with a different description")
        );
      }

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

      // امسح أي فيديو سابق
      setVideoBlob(null);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
      setDebugInfo("");

      // Auto-wire the generated image into the preview canvas + imageFile
      // عشان مربع المعاينة يشتغل على طول من غير ما المستخدم يضغط حاجة تانية
      const file = base64ImageToFile(
        result.image_base64,
        result.image_mime || "image/png",
        `ai-character-${Date.now()}.png`
      );
      setImageFile(file);

      try {
        const img = await loadImage(url);
        imageRef.current = img;
        setUploadedImage(url);
        // force preview redraw:
        // نمرّ بـ false الأول عشان useEffect يتشغّل تاني حتى لو imageReady كان true
        setImageReady(false);
        // استنى frame عشان الـ false يتعمل render الأول
        requestAnimationFrame(() => {
          setImageReady(true);
        });
      } catch (e) {
        setDebugInfo(lang === "ar" ? "فشل تحميل صورة الشخصية" : "Failed to load generated image");
      }

      toast({
        title: t.charSuccess,
        description: lang === "ar"
          ? "الشخصية جاهزة في المعاينة - تقدر تكمل للصوت والفيديو"
          : "Character ready in preview - proceed to voice & video",
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      const errType = e?.error_type || "unknown";
      // خصّص الرسالة حسب نوع الخطأ
      let title = t.charError;
      let desc = msg;

      if (errType === "content_filter") {
        title = lang === "ar" ? "🚫 المحتوى مرفوض" : "🚫 Content rejected";
        // الـ message من الـ backend أصلاً مظبوط للغة دي
      } else if (errType === "rate_limit") {
        title = lang === "ar" ? "⏳ الـ AI مشغول" : "⏳ AI busy";
      } else if (errType === "timeout") {
        title = lang === "ar" ? "⌛ انتهى الوقت" : "⌛ Timed out";
      } else if (errType === "server") {
        title = lang === "ar" ? "⚠ مشكلة في السيرفر" : "⚠ Server issue";
      }

      setDebugInfo(`${t.charError}: ${msg}`);
      toast({
        variant: "destructive",
        title,
        description: desc,
      });
      console.warn("[handleGenerateCharacter] error:", errType, msg);
    } finally {
      setGeneratingChar(false);
      setGenCharStep("");
    }
  };

  // زرار "استخدم الصورة دي" - بقى مجرد shortcut للانتقال لتبويب الصوت
  // (الصورة اتاعتمدت تلقائيًا فوق)
  const handleUseGeneratedCharacter = () => {
    if (!generatedChar) return;
    setActiveTab("voice");
    toast({
      title: lang === "ar" ? "تم اعتماد الشخصية" : "Character selected",
      description: lang === "ar" ? "تقدر تكمل للصوت والفيديو دلوقتي" : "Proceed to voice & video",
    });
  };

  // === كشف الوجوه في الصورة الحالية ===
  // بيتنادي تلقائياً بعد ما imageFile يتحدد (upload أو generate أو edit).
  // لو الصورة فيها وجه واحد بس، بنتعامل معاها تلقائياً (face_index = -1).
  // لو فيها أكتر من وجه، المستخدم بيدوس على الوجه اللي عاوزه.
  //
  // مهم: بنستخدم lastDetectedFileKeyRef عشان نتجنّب إعادة كشف الوجوه لنفس الصورة.
  // من غير ده، كان كل ما backendStatus يتغير (كل 5 ثواني) بيتعمل detect-faces جديد،
  // وده بيستهلك 12-28 ثانية لكل call على CPU ويحمّل السيرفر بلا داعي.
  const runFaceDetection = useCallback(async (file: File | null) => {
    if (!file) return;
    // لو الـ backend مش شغال أو Wav2Lip مش متاح، نتخطى كشف الوجوه بهدوء
    if (backendStatus !== "ok" || backendInfo?.wav2lip_available === false) return;

    // تجنّب إعادة كشف الوجوه لنفس الملف (بناءً على name + size + lastModified)
    const fileKey = `${file.name}_${file.size}_${file.lastModified}`;
    if (lastDetectedFileKeyRef.current === fileKey) {
      // نفس الصورة اتكشفت قبل كده — نتخطى
      return;
    }
    lastDetectedFileKeyRef.current = fileKey;

    setDetectingFaces(true);
    setFaceDetectError("");
    setDetectedFaces([]);
    setSelectedFaceIndex(-1);

    try {
      const result = await detectFaces(file, file.name || "character.png");
      setDetectedFaces(result.faces);
      setImageNaturalSize({ w: result.image_width, h: result.image_height });

      if (result.count === 0) {
        // مفيش وجوه - خليها تلقائي وخزّن رسالة
        setFaceDetectError(t.faceNoFaces);
      } else if (result.count === 1) {
        // وجه واحد - نستخدمه تلقائياً
        setSelectedFaceIndex(0);
      }
      // لو أكتر من وجه، المستخدم لازم يختار بنفسه (selectedFaceIndex يفضل -1 = تلقائي = أول وجه)
    } catch (e: any) {
      // فشل كشف الوجوه - مش خطأ قاتل، هنكمل بالوضع التلقائي
      console.warn("[runFaceDetection] failed:", e?.message);
      setFaceDetectError(t.faceDetectionFailed);
      // صفّر الـ ref عشان لو المستخدم حاول تاني يقدر
      lastDetectedFileKeyRef.current = null;
    } finally {
      setDetectingFaces(false);
    }
  }, [backendStatus, backendInfo, t.faceNoFaces, t.faceDetectionFailed]);

  // لما imageFile يتغير (فقط)، شغّل كشف الوجوه تلقائياً
  // ملحوظة: runFaceDetection بيتعملها reference جديد كل ما backendStatus يتغير،
  // بس بفضل الـ lastDetectedFileKeyRef، الـ call الفعلي بيـskip لو نفس الصورة.
  useEffect(() => {
    if (imageFile && imageReady) {
      runFaceDetection(imageFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageFile, imageReady]);

  // === Multi-speaker helpers ===
  // لما الوجوه تتكشف، لو أكتر من وجه، نضيف segment لكل وجه افتراضياً.
  // المستخدم يقدر يعدّل/يزود/يشيل بعد كده.
  useEffect(() => {
    if (detectedFaces.length > 1 && multiSegments.length === 0) {
      // ابدأ بـ segment واحد لكل وجه، فاضي (المستخدم يكتبه)
      setMultiSegments(
        detectedFaces.map((face) => ({
          face_index: face.index,
          text: "",
          voice: selectedVoice,
          rate: speechRate,
        }))
      );
    }
    // لو الوجوه اتغيرت (مثلاً صورة جديدة)، صفّر الـ segments
    if (detectedFaces.length === 0 && multiSegments.length > 0) {
      setMultiSegments([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedFaces]);

  const updateMultiSegment = (idx: number, patch: Partial<MultiSegment>) => {
    setMultiSegments((prev) =>
      prev.map((seg, i) => (i === idx ? { ...seg, ...patch } : seg))
    );
  };

  const addMultiSegment = () => {
    if (multiSegments.length >= 6) return; // حد أقصى 6
    // لو في وجوه، استخدم أول وجه افتراضياً
    const defaultFace = detectedFaces.length > 0 ? detectedFaces[0].index : 0;
    setMultiSegments((prev) => [
      ...prev,
      {
        face_index: defaultFace,
        text: "",
        voice: selectedVoice,
        rate: speechRate,
      },
    ]);
  };

  const removeMultiSegment = (idx: number) => {
    setMultiSegments((prev) => prev.filter((_, i) => i !== idx));
  };

  // تعديل الصورة المولّدة بالـ AI (image-to-image)
  const handleEditCharacter = async () => {
    if (!generatedChar || !generatedChar.image_base64) return;
    const trimmed = editPrompt.trim();
    if (!trimmed) {
      toast({
        title: lang === "ar" ? "اكتب التعديل" : "Describe the edit",
        variant: "destructive",
      });
      return;
    }

    setEditingChar(true);
    setEditStep(lang === "ar" ? "بتعديل الصورة..." : "Editing image...");
    setEditProgress(5);
    setEditElapsed(0);

    try {
      const result = await editCharacter({
        image_base64: generatedChar.image_base64,
        edit_prompt: trimmed,
        language: lang,
      }, (progress, message, elapsedSec) => {
        if (message) setEditStep(message);
        if (typeof progress === "number") setEditProgress(progress);
        if (typeof elapsedSec === "number") setEditElapsed(elapsedSec);
      });

      // حدّث الصورة المعروضة بالصورة المعدّلة
      const cleaned = result.image_base64.replace(/^data:[^;]+;base64,/, "");
      const binary = atob(cleaned);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: result.image_mime || "image/png" });
      const url = URL.createObjectURL(blob);

      if (generatedImageUrl) URL.revokeObjectURL(generatedImageUrl);
      setGeneratedImageUrl(url);
      setGeneratedChar({
        ...generatedChar,
        image_base64: result.image_base64,
        image_mime: result.image_mime,
        prompt_used: `${generatedChar.prompt_used} + EDIT: ${trimmed}`,
      });

      // حدّث الـ imageFile كمان
      const file = base64ImageToFile(
        result.image_base64,
        result.image_mime || "image/png",
        "ai-character-edited.png"
      );
      setImageFile(file);
      setImageReady(true);

      setEditPrompt("");
      setShowEditBox(false);
      toast({
        title: lang === "ar" ? "تم تعديل الصورة" : "Image edited",
        description: lang === "ar" ? "الصورة المعدّلة جاهزة" : "Edited image is ready",
      });
    } catch (e: any) {
      const errType = e?.error_type || "unknown";
      // خصّص الرسالة حسب نوع الخطأ
      let title = lang === "ar" ? "⚠ فشل التعديل" : "⚠ Edit failed";
      let desc = e?.message || (lang === "ar" ? "حاول تاني" : "Try again");

      if (errType === "content_filter") {
        title = lang === "ar" ? "🚫 المحتوى مرفوض" : "🚫 Content rejected";
        // الـ message من الـ backend أصلاً مظبوط للغة دي
      } else if (errType === "rate_limit") {
        title = lang === "ar" ? "⏳ الـ AI مشغول" : "⏳ AI busy";
      } else if (errType === "timeout") {
        title = lang === "ar" ? "⌛ انتهى الوقت" : "⌛ Timed out";
      }

      toast({
        title,
        description: desc,
        variant: "destructive",
      });
      console.warn("[handleEditCharacter] error:", errType, e?.message);
    } finally {
      setEditingChar(false);
      setEditStep("");
      setEditProgress(0);
      setEditElapsed(0);
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

    // فحص مسبق: تأكد إن Wav2Lip متاح قبل ما نبدأ
    if (backendInfo && backendInfo.wav2lip_available === false) {
      const msg = lang === "ar"
        ? "محرّك تحريك الشفاه (Wav2Lip) مش متوفر على السيرفر. الموديل محتاج تنزيل يدوي — تواصل مع المسؤول."
        : "Wav2Lip engine is not available on this server. The model needs manual download — contact admin.";
      setDebugInfo(msg);
      toast({
        variant: "destructive",
        title: lang === "ar" ? "ميزة مش متاحة" : "Feature unavailable",
        description: msg,
      });
      return;
    }

    // فحص مسبق سريع للـ backend المحلي (http://localhost:8000) — مش Vercel proxy.
    // ده بيكشف لو الـ backend وقع أثناء شغل سابق (OOM) أو لسه بيبدأ.
    const preflightErr = await preflightBackendCheck(lang);
    if (preflightErr) {
      setDebugInfo(preflightErr);
      toast({
        variant: "destructive",
        title: lang === "ar" ? "السيرفر مش متاح" : "Server unavailable",
        description: preflightErr,
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
        faceIndex: selectedFaceIndex, // -1 = تلقائي، أو index الوجه المحدد
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
      const errType = (e?.error_type as string) || "unknown";
      // رسالة خطأ واضحة بالعربي بناءً على نوع الخطأ
      let msg: string;
      if (errType === "wav2lip_unavailable") {
        msg = lang === "ar"
          ? "محرّك تحريك الشفاه (Wav2Lip) مش متوفر على السيرفر. الموديل محتاج تنزيل يدوي — تواصل مع المسؤول."
          : "Wav2Lip engine is not available on this server. The model needs manual download — contact admin.";
      } else if (errType === "torch_missing") {
        msg = lang === "ar"
          ? "مكتبة PyTorch مش متثبتة على السيرفر — تواصل مع المسؤول."
          : "PyTorch is not installed on the server — contact admin.";
      } else if (errType === "tts_failed") {
        msg = lang === "ar"
          ? "فشل توليد الصوت من النص. جرّب صوت تاني أو ارفع ملف صوتي."
          : "TTS failed. Try a different voice or upload an audio file.";
      } else if (errType === "timeout") {
        msg = lang === "ar"
          ? "العملية أخدت وقت طويل أوي — جرّب ملف أصغر."
          : "Operation timed out — try a smaller file.";
      } else if (errType === "backend_crashed") {
        msg = lang === "ar"
          ? "السيرفر وقع أثناء المعالجة (نفذت الذاكرة). جرّب تاني — لو الصورة فيها أكتر من وجه، الصورة اتتصغّرت تلقائياً. لو الفيديو طويل، جرّب نص أقصر."
          : "The server crashed during processing (out of memory). Try again — the image is auto-downsized. If the video is long, try a shorter script.";
      } else if (errType === "backend_unavailable" || (e?.message || "").includes("fetch failed")) {
        msg = lang === "ar"
          ? "السيرفر مش متاح حالياً. استنى ثواني وحاول تاني."
          : "The server is temporarily unavailable. Wait a few seconds and try again.";
      } else {
        msg = e?.message || String(e);
      }
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

  // === توليد فيديو الحوار المتعدد ===
  // بيولّد فيديو واحد فيه كل الشخصيات بتقول سكربتها بالترتيب.
  // كل segment = face + text + voice → Wav2Lip → concat كلهم.
  const handleGenerateMulti = async () => {
    setDebugInfo("");

    if (!imageFile) {
      const msg = lang === "ar" ? "ارفع صورة الأول" : "Upload an image first";
      setDebugInfo(msg);
      toast({ variant: "destructive", title: lang === "ar" ? "بيانات ناقصة" : "Missing Data", description: msg });
      setActiveTab("character");
      return;
    }

    if (detectedFaces.length < 2) {
      const msg = lang === "ar"
        ? "الحوار المتعدد محتاج صورة فيها أكتر من شخص. ولّد أو ارفع صورة فيها أكتر من وجه."
        : "Multi-speaker dialogue needs an image with more than one person. Generate or upload an image with multiple faces.";
      setDebugInfo(msg);
      toast({ variant: "destructive", title: lang === "ar" ? "صورة مش مناسبة" : "Image not suitable", description: msg });
      return;
    }

    // شيل الفقرات الفاضية واتأكد إن كل فقرة ليها face_index صالح
    const validSegments = multiSegments.filter((s) => s.text.trim().length > 0);
    if (validSegments.length === 0) {
      const msg = lang === "ar"
        ? "اكتب سكربت لفقرة واحدة على الأقل"
        : "Write a script for at least one line";
      setDebugInfo(msg);
      toast({ variant: "destructive", title: lang === "ar" ? "بيانات ناقصة" : "Missing Data", description: msg });
      return;
    }

    // تأكد إن face_index صالح (ضمن نطاق الوجوه المكتشفة)
    for (let i = 0; i < validSegments.length; i++) {
      const faceIdx = validSegments[i].face_index;
      const faceExists = detectedFaces.some((f) => f.index === faceIdx);
      if (!faceExists) {
        const msg = lang === "ar"
          ? `الفقرة ${i + 1}: الوجه رقم ${faceIdx + 1} مش موجود في الصورة. اختار وجه صحيح.`
          : `Line ${i + 1}: Face #${faceIdx + 1} doesn't exist in the image. Pick a valid face.`;
        setDebugInfo(msg);
        toast({ variant: "destructive", title: lang === "ar" ? "وجه مش صالح" : "Invalid face", description: msg });
        return;
      }
    }

    if (backendStatus !== "ok") {
      const msg = lang === "ar"
        ? "الـ backend مش شغال. شغّل السيرفر الأول."
        : "Backend not running. Start the server first.";
      setDebugInfo(msg);
      toast({ variant: "destructive", title: lang === "ar" ? "خطأ في الاتصال" : "Connection Error", description: msg });
      return;
    }

    if (backendInfo && backendInfo.wav2lip_available === false) {
      const msg = lang === "ar"
        ? "محرّك تحريك الشفاه (Wav2Lip) مش متوفر على السيرفر."
        : "Wav2Lip engine is not available on this server.";
      setDebugInfo(msg);
      toast({ variant: "destructive", title: lang === "ar" ? "ميزة مش متاحة" : "Feature unavailable", description: msg });
      return;
    }

    // فحص مسبق سريع للـ backend المحلي (http://localhost:8000)
    const preflightErr = await preflightBackendCheck(lang);
    if (preflightErr) {
      setDebugInfo(preflightErr);
      toast({
        variant: "destructive",
        title: lang === "ar" ? "السيرفر مش متاح" : "Server unavailable",
        description: preflightErr,
      });
      return;
    }

    setIsGenerating(true);
    setGenerateProgress(0);
    setGenerateMessage(lang === "ar" ? "بتجهيز الحوار..." : "Preparing dialogue...");
    setVideoBlob(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);

    requestAnimationFrame(() => setActiveTab("preview"));

    try {
      // 1. ابدأ الـ job
      setGenerateMessage(lang === "ar" ? "بإرسال الحوار للـ AI..." : "Submitting dialogue to AI...");

      // بنّشئ scripts array للـ API
      const scripts: MultiScriptEntry[] = validSegments.map((s) => ({
        face_index: s.face_index,
        text: s.text.trim(),
        voice: s.voice,
        rate: s.rate,
      }));

      const { job_id } = await startMultiLipSync(imageFile, scripts, imageFile.name || "character.png");
      jobIdRef.current = job_id;
      console.log("Multi-speaker job started:", job_id);

      // 2. راقب التقدم
      setGenerateMessage(lang === "ar" ? "الذكاء الاصطناعي بيشتغل على الحوار..." : "AI is processing dialogue...");
      const finalStatus: LipSyncJobStatus = await pollJobUntilDone(
        job_id,
        (status) => {
          setGenerateProgress(status.progress);
          setGenerateMessage(status.message || (lang === "ar" ? "جاري المعالجة..." : "Processing..."));
        },
        1500,
        300 // 7.5 دقيقة max — الحوار بياخد وقت أطول
      );
      console.log("Multi job completed:", finalStatus);

      // 3. حمّل الفيديو
      setGenerateMessage(lang === "ar" ? "بتحميل فيديو الحوار..." : "Downloading dialogue video...");
      setGenerateProgress(100);
      const blob = await downloadVideo(job_id);

      const url = URL.createObjectURL(blob);
      setVideoBlob(blob);
      setVideoUrl(url);
      setGenerateMessage("");

      toast({
        title: t.multiVideoReady,
        description: `${(blob.size / 1024 / 1024).toFixed(1)} MB · ${scripts.length} ${lang === "ar" ? "فقرة" : "lines"} · MP4`,
      });

      setTimeout(() => cleanupJob(job_id), 30000);
    } catch (e: any) {
      const errType = (e?.error_type as string) || "unknown";
      let msg: string;
      if (errType === "wav2lip_unavailable") {
        msg = lang === "ar"
          ? "محرّك تحريك الشفاه (Wav2Lip) مش متوفر على السيرفر."
          : "Wav2Lip engine is not available on this server.";
      } else if (errType === "torch_missing") {
        msg = lang === "ar"
          ? "مكتبة PyTorch مش متثبتة على السيرفر — تواصل مع المسؤول."
          : "PyTorch is not installed on the server — contact admin.";
      } else if (errType === "tts_failed") {
        msg = lang === "ar"
          ? "فشل توليد الصوت لواحدة من الفقرات. جرّب صوت تاني أو نص أقصر."
          : "TTS failed for one of the lines. Try a different voice or shorter text.";
      } else if (errType === "face_index_out_of_range") {
        msg = lang === "ar"
          ? "واحدة من الفقرات بتشير لوجه مش موجود في الصورة. تأكد من اختيار الوجه الصحيح."
          : "One of the lines references a face that doesn't exist. Make sure the selected face is valid.";
      } else if (errType === "timeout") {
        msg = lang === "ar"
          ? "الحوار أخد وقت طويل أوي — جرّب فقرات أقصر أو فقرات أقل."
          : "Dialogue took too long — try shorter or fewer lines.";
      } else if (errType === "backend_crashed") {
        msg = lang === "ar"
          ? "السيرفر وقع أثناء معالجة الحوار (نفذت الذاكرة). جرّب فقرات أقصر أو أقل."
          : "The server crashed during dialogue processing (out of memory). Try shorter or fewer lines.";
      } else if (errType === "backend_unavailable" || (e?.message || "").includes("fetch failed")) {
        msg = lang === "ar"
          ? "السيرفر مش متاح حالياً. استنى ثواني وحاول تاني."
          : "The server is temporarily unavailable. Wait a few seconds and try again.";
      } else {
        msg = e?.message || String(e);
      }
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

  // تنزيل صورة الشخصية المولّدة بالـ AI
  const handleDownloadCharacterImage = () => {
    if (!generatedChar?.image_base64) return;
    const mime = generatedChar.image_mime || "image/png";
    const ext = mime === "image/jpeg" ? "jpg" : "png";
    const b64 = generatedChar.image_base64.replace(/^data:[^;]+;base64,/, "");
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `character-ai-${Date.now()}.${ext}`;
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
      <header className="border-b border-purple-500/20 backdrop-blur-md bg-black/20 relative z-50">
        <div className="container mx-auto px-2 sm:px-4 py-3 sm:py-4 flex items-center justify-between gap-2">
          {/* Logo + Title */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-shrink">
            <div className="w-9 h-9 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-purple-500/30 shrink-0">
              <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl font-bold bg-gradient-to-r from-purple-300 to-pink-300 bg-clip-text text-transparent truncate">
                {t.appTitle}
              </h1>
              <p className="text-[10px] sm:text-xs text-gray-300 flex items-center gap-1 truncate">
                <Cpu className="w-2.5 h-2.5 sm:w-3 sm:h-3 shrink-0" />
                <span className="truncate">{t.aiPoweredBy}</span>
              </p>
            </div>
          </div>
          {/* Right controls */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
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
                  <span className="w-2 h-2 rounded-full bg-green-500 mr-1 animate-pulse shrink-0" />
                  <span className="hidden sm:inline">AI {backendInfo?.device === "cuda" ? "GPU" : "CPU"}</span>
                  <span className="sm:hidden">AI</span>
                </>
              ) : backendStatus === "starting" ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin shrink-0" />
                  <span className="hidden sm:inline">{lang === "ar" ? "تشغيل السيرفر..." : "Starting..."}</span>
                  <span className="sm:hidden">…</span>
                </>
              ) : backendStatus === "down" ? (
                <>
                  <AlertCircle className="w-3 h-3 mr-1 shrink-0" />
                  <span className="hidden sm:inline">{lang === "ar" ? "السيرفر مطفي" : "Backend down"}</span>
                  <span className="sm:hidden">!</span>
                </>
              ) : (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin shrink-0" />
                  <span className="hidden sm:inline">{lang === "ar" ? "فحص..." : "Checking..."}</span>
                  <span className="sm:hidden">…</span>
                </>
              )}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleLang}
              className="border-purple-500/30 hover:bg-purple-500/10 px-2 sm:px-3"
            >
              <Globe className="w-4 h-4 sm:mr-2 shrink-0" />
              <span className="hidden sm:inline">{lang === "ar" ? "English" : "عربي"}</span>
            </Button>
            {/* User dropdown menu — shows only the name, opens a menu on click */}
            {currentUser && (
              <div className="relative" data-user-menu>
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((v) => !v)}
                  className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-md bg-white/5 border border-purple-500/30 text-gray-200 hover:bg-white/10 hover:border-purple-500/50 transition-colors text-sm"
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                >
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 text-white text-xs font-bold shrink-0">
                    {currentUser.charAt(0).toUpperCase()}
                  </span>
                  <span className="hidden md:inline max-w-[120px] truncate">
                    {currentUser}
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-gray-400 transition-transform ${userMenuOpen ? "rotate-180" : ""} shrink-0`}
                  />
                </button>

                {/* Dropdown */}
                {userMenuOpen && (
                  <div
                    role="menu"
                    className="absolute end-0 mt-2 w-44 max-w-[calc(100vw-1rem)] bg-[#161820] border border-purple-500/30 rounded-lg shadow-xl py-1 z-[100]"
                    style={{ direction: lang === "ar" ? "rtl" : "ltr" }}
                  >
                    {/* User info header (name only — NO email) */}
                    <div className="px-3 py-2 border-b border-white/5">
                      <p className="text-xs text-gray-500">
                        {lang === "ar" ? "داخل باسم" : "Signed in as"}
                      </p>
                      <p className="text-sm font-medium text-gray-200 truncate">
                        {currentUser}
                      </p>
                    </div>

                    {/* Logout */}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleLogout}
                      disabled={loggingOut}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-60"
                    >
                      {loggingOut ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <LogOut className="w-4 h-4" />
                      )}
                      <span>
                        {lang === "ar" ? "تسجيل الخروج" : "Sign out"}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}
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
                <TabsTrigger value="character" className="data-[state=active]:bg-purple-500/30 data-[state=active]:text-white text-gray-200">
                  <User className="w-4 h-4 mr-2" />
                  <span className="hidden sm:inline">{t.tabCharacter}</span>
                </TabsTrigger>
                <TabsTrigger value="voice" className="data-[state=active]:bg-purple-500/30 data-[state=active]:text-white text-gray-200">
                  <Music className="w-4 h-4 mr-2" />
                  <span className="hidden sm:inline">{t.tabVoice}</span>
                </TabsTrigger>
                <TabsTrigger value="preview" className="data-[state=active]:bg-purple-500/30 data-[state=active]:text-white text-gray-200">
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

                      {/* Style + Gender selectors — استخدمنا button toggles بدل Radix Select
                          عشان Radix Select بيتعارك مع browser extensions (زي Google Translate)
                          ويسبب "removeChild" error. */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
                        <div>
                          <Label className="text-sm text-purple-200 mb-2 block flex items-center gap-2">
                            <ImageIcon className="w-4 h-4" />
                            {t.charStyleLabel}
                          </Label>
                          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t.charStyleLabel}>
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
                            ).map((s) => {
                              const active = charStyle === s.id;
                              return (
                                <button
                                  key={s.id}
                                  type="button"
                                  role="radio"
                                  aria-checked={active}
                                  onClick={() => setCharStyle(s.id)}
                                  className={
                                    "px-2 py-2 rounded-md text-xs font-medium border transition-all text-center " +
                                    (active
                                      ? "bg-gradient-to-r from-purple-500 to-pink-500 border-pink-400 text-white shadow-md"
                                      : "bg-black/40 border-purple-500/20 text-purple-200 hover:border-pink-500/40 hover:text-pink-200")
                                  }
                                >
                                  {s.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div>
                          <Label className="text-sm text-purple-200 mb-2 block flex items-center gap-2">
                            <User className="w-4 h-4" />
                            {t.charGenderLabel}
                          </Label>
                          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t.charGenderLabel}>
                            {(charGenders.length > 0
                              ? charGenders
                              : [
                                  { id: "any", label_ar: t.charGenderAny, label_en: t.charGenderAny },
                                  { id: "male", label_ar: t.charGenderMale, label_en: t.charGenderMale },
                                  { id: "female", label_ar: t.charGenderFemale, label_en: t.charGenderFemale },
                                ]
                            ).map((g) => {
                              const active = charGender === g.id;
                              const label = lang === "ar" ? g.label_ar : g.label_en;
                              return (
                                <button
                                  key={g.id}
                                  type="button"
                                  role="radio"
                                  aria-checked={active}
                                  onClick={() => setCharGender(g.id)}
                                  className={
                                    "px-2 py-2 rounded-md text-xs font-medium border transition-all text-center " +
                                    (active
                                      ? "bg-gradient-to-r from-purple-500 to-pink-500 border-pink-400 text-white shadow-md"
                                      : "bg-black/40 border-purple-500/20 text-purple-200 hover:border-pink-500/40 hover:text-pink-200")
                                  }
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
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

                          {/* Edit box (AI image-to-image) */}
                          {showEditBox && !editingChar && (
                            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 space-y-2">
                              <Label className="text-xs text-blue-200 block">
                                {lang === "ar" ? "اكتب التعديل اللي عاوزه" : "Describe the edit you want"}
                              </Label>
                              <textarea
                                value={editPrompt}
                                onChange={(e) => setEditPrompt(e.target.value)}
                                placeholder={lang === "ar"
                                  ? "مثال: ضيف نظارة، غيّر لون البدلة لـ أزرق، خلّي الخلفية مكتب..."
                                  : "e.g. add glasses, change suit color to blue, make background an office..."}
                                rows={3}
                                maxLength={500}
                                dir={isRTL ? "rtl" : "ltr"}
                                className="w-full px-3 py-2 text-sm bg-black/40 border border-blue-500/30 rounded-md text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-400 resize-none"
                              />
                              <div className="flex gap-2">
                                <Button
                                  onClick={handleEditCharacter}
                                  className="flex-1 bg-blue-600 hover:bg-blue-700"
                                >
                                  <Wand2 className="w-4 h-4 mr-2" />
                                  {lang === "ar" ? "نفّذ التعديل" : "Apply Edit"}
                                </Button>
                                <Button
                                  onClick={() => { setShowEditBox(false); setEditPrompt(""); }}
                                  variant="outline"
                                  className="border-blue-500/30"
                                >
                                  {lang === "ar" ? "إلغاء" : "Cancel"}
                                </Button>
                              </div>
                            </div>
                          )}

                          {/* Editing progress */}
                          {editingChar && (
                            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 space-y-2">
                              <div className="flex items-center gap-3">
                                <Loader2 className="w-5 h-5 text-blue-300 animate-spin flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-blue-100 truncate">
                                    {editStep || (lang === "ar" ? "جاري التعديل..." : "Editing...")}
                                  </p>
                                  <p className="text-xs text-blue-300/70">
                                    {lang === "ar"
                                      ? `التعديل بالـ AI بياخد ~30 ثانية · ${editElapsed}ث مضت`
                                      : `AI edit takes ~30s · ${editElapsed}s elapsed`}
                                  </p>
                                </div>
                                <span className="text-xs font-mono text-blue-200 flex-shrink-0">
                                  {editProgress}%
                                </span>
                              </div>
                              {/* Progress bar */}
                              <div className="w-full h-1.5 bg-blue-950/50 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-500 ease-out"
                                  style={{ width: `${Math.min(100, Math.max(3, editProgress))}%` }}
                                />
                              </div>
                            </div>
                          )}

                          {/* Quick edit suggestion chips */}
                          {!showEditBox && !editingChar && (
                            <div className="flex flex-wrap gap-1.5">
                              {(lang === "ar"
                                ? ["ضيف نظارة", "غيّر الخلفية لمكتب", "اجعلها أنمي", "أضف ابتسامة"]
                                : ["Add glasses", "Office background", "Make it anime", "Add a smile"]
                              ).map((suggestion) => (
                                <button
                                  key={suggestion}
                                  type="button"
                                  onClick={() => { setEditPrompt(suggestion); setShowEditBox(true); }}
                                  className="px-2.5 py-1 text-xs rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-200 hover:bg-blue-500/20 transition-colors"
                                >
                                  {suggestion}
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Action buttons */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <Button
                              onClick={handleGenerateCharacter}
                              variant="outline"
                              className="border-purple-500/30 hover:bg-purple-500/10"
                            >
                              <RefreshCw className="w-4 h-4 mr-2" />
                              {t.charRegenerate}
                            </Button>
                            <Button
                              onClick={() => setShowEditBox(!showEditBox)}
                              variant="outline"
                              className="border-blue-500/30 hover:bg-blue-500/10 text-blue-200"
                              disabled={editingChar}
                            >
                              <Wand2 className="w-4 h-4 mr-2" />
                              {lang === "ar" ? "عدّل الصورة" : "Edit Image"}
                            </Button>
                            <Button
                              onClick={handleDownloadCharacterImage}
                              variant="outline"
                              className="border-cyan-500/30 hover:bg-cyan-500/10 text-cyan-200"
                            >
                              <Download className="w-4 h-4 mr-2" />
                              {t.charDownload}
                            </Button>
                            <Button
                              onClick={handleUseGeneratedCharacter}
                              className="bg-green-600 hover:bg-green-700"
                            >
                              <CheckCircle2 className="w-4 h-4 mr-2" />
                              {lang === "ar" ? "التالي" : "Next"}
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

                  {/* === Speaker mode toggle (single vs multi) === */}
                  {/* الـ toggle ده بيظهر بس لو الصورة فيها أكتر من وجه */}
                  {detectedFaces.length > 1 ? (
                    <div className="mb-6">
                      <Label className="text-xs text-gray-300 mb-2 block flex items-center gap-2">
                        <Users className="w-4 h-4" />
                        {t.multiSpeakerTitle}
                      </Label>
                      <div className="grid grid-cols-2 gap-2 p-1 bg-black/30 rounded-lg border border-purple-500/20">
                        <button
                          type="button"
                          onClick={() => setSpeakerMode("single")}
                          className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                            speakerMode === "single"
                              ? "bg-purple-500/30 text-purple-100 border border-purple-500/50"
                              : "text-gray-200 hover:text-purple-100"
                          }`}
                        >
                          <User className="w-4 h-4" />
                          {t.singleSpeakerMode}
                        </button>
                        <button
                          type="button"
                          onClick={() => setSpeakerMode("multi")}
                          className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                            speakerMode === "multi"
                              ? "bg-purple-500/30 text-purple-100 border border-purple-500/50"
                              : "text-gray-200 hover:text-purple-100"
                          }`}
                        >
                          <Users className="w-4 h-4" />
                          {t.multiSpeakerMode}
                        </button>
                      </div>
                      <p className="text-xs text-gray-400 mt-2">{t.multiSpeakerHint}</p>
                    </div>
                  ) : (
                    /* لو الصورة فيها وجه واحد بس، اعرض رسالة إن الميزة مش متاحة */
                    <div className="mb-6 p-3 rounded-lg bg-black/20 border border-purple-500/10 text-xs text-gray-400 flex items-start gap-2">
                      <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-purple-400" />
                      <span>{t.multiSpeakerAvailable}</span>
                    </div>
                  )}

                  {/* === Multi-speaker editor === */}
                  {speakerMode === "multi" && detectedFaces.length > 1 ? (
                    <div className="space-y-4">
                      {multiSegments.map((seg, idx) => (
                        <div
                          key={idx}
                          className="p-4 rounded-lg bg-black/40 border border-purple-500/30 space-y-3"
                        >
                          {/* Header: face selector + remove button */}
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 flex-1">
                              <Badge variant="outline" className="text-xs px-2 py-1">
                                {t.segmentLabel} {idx + 1}
                              </Badge>
                              <Select
                                value={String(seg.face_index)}
                                onValueChange={(v) => updateMultiSegment(idx, { face_index: parseInt(v, 10) })}
                              >
                                <SelectTrigger className="bg-black/40 border-purple-500/30 text-purple-100 h-8 text-xs flex-1">
                                  <SelectValue placeholder={t.multiSelectFace} />
                                </SelectTrigger>
                                <SelectContent className="bg-slate-900 border-purple-500/30">
                                  {detectedFaces.map((face) => {
                                    const v = voices.find((vv) => vv.id === seg.voice);
                                    const isFemale = v?.gender === "Female";
                                    const isChild = v?.category === "child";
                                    return (
                                      <SelectItem key={face.index} value={String(face.index)}>
                                        <span className="flex items-center gap-2">
                                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                                            isChild
                                              ? (isFemale ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300")
                                              : (isFemale ? "bg-pink-500/20 text-pink-300" : "bg-blue-500/20 text-blue-300")
                                          }`}>
                                            {isChild ? "🧒" : (isFemale ? "♀" : "♂")}
                                          </span>
                                          {t.faceNumber} {face.index + 1}
                                        </span>
                                      </SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                            </div>
                            {multiSegments.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeMultiSegment(idx)}
                                className="h-8 w-8 p-0 text-red-300 hover:text-red-200 hover:bg-red-500/10"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>

                          {/* Voice selector */}
                          <div>
                            <Label className="text-xs text-gray-300 mb-1 block">
                              {t.voiceForFace} {seg.face_index + 1}
                            </Label>
                            <Select
                              value={seg.voice}
                              onValueChange={(v) => updateMultiSegment(idx, { voice: v })}
                            >
                              <SelectTrigger className="bg-black/40 border-purple-500/30 text-purple-100 h-9 text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-slate-900 border-purple-500/30 max-h-72">
                                {voices.length === 0 ? (
                                  <SelectItem value="ar-EG-SalmaNeural">
                                    {lang === "ar" ? "سلمى (مصر - أنثى)" : "Salma (Egypt - Female)"}
                                  </SelectItem>
                                ) : (
                                  voices.map((v) => (
                                    <SelectItem key={v.id} value={v.id}>
                                      <span className="flex items-center gap-2">
                                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                                          v.category === "child"
                                            ? (v.gender === "Female" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300")
                                            : (v.gender === "Female" ? "bg-pink-500/20 text-pink-300" : "bg-blue-500/20 text-blue-300")
                                        }`}>
                                          {v.category === "child" ? "🧒" : (v.gender === "Female" ? "♀" : "♂")}
                                        </span>
                                        {lang === "ar" ? v.label_ar : v.label_en}
                                      </span>
                                    </SelectItem>
                                  ))
                                )}
                              </SelectContent>
                            </Select>
                          </div>

                          {/* Script textarea */}
                          <div>
                            <Label className="text-xs text-gray-300 mb-1 block">
                              {t.scriptForFace} {seg.face_index + 1}
                            </Label>
                            <textarea
                              value={seg.text}
                              onChange={(e) => updateMultiSegment(idx, { text: e.target.value.slice(0, 2000) })}
                              placeholder={t.scriptPlaceholder}
                              rows={3}
                              className="w-full px-3 py-2 rounded-lg bg-black/40 border border-purple-500/30 text-purple-100 placeholder-gray-400 focus:outline-none focus:border-purple-500/60 resize-y text-sm leading-relaxed"
                              dir={isRTL ? "rtl" : "ltr"}
                            />
                          </div>
                        </div>
                      ))}

                      {/* Add segment button */}
                      {multiSegments.length < 6 && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={addMultiSegment}
                          className="w-full border-dashed border-purple-500/30 hover:bg-purple-500/10"
                        >
                          <Plus className="w-4 h-4 mr-2" />
                          {t.addSegment}
                        </Button>
                      )}
                      {multiSegments.length >= 6 && (
                        <p className="text-xs text-center text-gray-400">{t.multiMaxSegments}</p>
                      )}
                    </div>
                  ) : (
                    /* === Single speaker mode (السلوك الأصلي) === */
                    <>
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
                                      v.category === "child"
                                        ? (v.gender === "Female" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300")
                                        : (v.gender === "Female" ? "bg-pink-500/20 text-pink-300" : "bg-blue-500/20 text-blue-300")
                                    }`}>
                                      {v.category === "child" ? "🧒" : (v.gender === "Female" ? "♀" : "♂")}
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
                    {/* === اختيار الوجه للصور متعددة الوجوه === */}
                    {imageFile && imageReady && !videoUrl && (
                      <FaceSelector
                        imageSrc={uploadedImage || generatedImageUrl}
                        imageNaturalSize={imageNaturalSize}
                        detectedFaces={detectedFaces}
                        selectedFaceIndex={selectedFaceIndex}
                        detecting={detectingFaces}
                        error={faceDetectError}
                        onSelect={(idx) => setSelectedFaceIndex(idx)}
                        lang={lang}
                        t={t}
                      />
                    )}

                    <Button
                      onClick={speakerMode === "multi" && detectedFaces.length > 1 ? handleGenerateMulti : handleGenerateAI}
                      disabled={
                        isGenerating ||
                        backendStatus !== "ok" ||
                        (speakerMode === "multi" && detectedFaces.length > 1
                          ? multiSegments.filter((s) => s.text.trim()).length === 0
                          : !hasInput)
                      }
                      className="w-full bg-gradient-to-r from-yellow-500 via-purple-500 to-pink-500 hover:from-yellow-600 hover:via-purple-600 hover:to-pink-600 disabled:opacity-50 disabled:cursor-not-allowed"
                      size="lg"
                    >
                      <span className="inline-flex items-center justify-center">
                        {isGenerating ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : speakerMode === "multi" && detectedFaces.length > 1 ? (
                          <Users className="w-4 h-4 mr-2" />
                        ) : (
                          <Sparkles className="w-4 h-4 mr-2" />
                        )}
                        <span>
                          {isGenerating
                            ? `${t.generating} ${generateProgress}%`
                            : speakerMode === "multi" && detectedFaces.length > 1
                            ? t.generateMultiVideo
                            : t.generateVideo}
                        </span>
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
      <UpdateBanner />
      <BackendRestartButton language={lang} />
    </div>
  );
}
