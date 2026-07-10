"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, LogIn, Eye, EyeOff, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";

/**
 * Login page — admin-only auth.
 * Reads ADMIN_USERNAME / ADMIN_PASSWORD from server env via /api/login.
 *
 * Bilingual (ar/en) — defaults to Arabic, RTL.
 */
export default function LoginPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lang, setLang] = useState<"ar" | "en">("ar");

  // If already logged in, redirect to home
  useEffect(() => {
    fetch("/api/login", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data?.authenticated) {
          router.replace("/");
        }
      })
      .catch(() => {});
  }, [router]);

  const isRTL = lang === "ar";
  const t = {
    title: lang === "ar" ? "تسجيل الدخول" : "Sign In",
    subtitle:
      lang === "ar"
        ? "ادخل بياناتك للوصول لاستوديو الشخصيات المتكلمة"
        : "Enter your credentials to access the Talking Characters Studio",
    username: lang === "ar" ? "اسم المستخدم" : "Username",
    usernamePlaceholder: lang === "ar" ? "اكتب اسم المستخدم" : "Enter username",
    password: lang === "ar" ? "كلمة المرور" : "Password",
    passwordPlaceholder: lang === "ar" ? "اكتب كلمة المرور" : "Enter password",
    submit: lang === "ar" ? "دخول" : "Sign In",
    submitting: lang === "ar" ? "جاري الدخول..." : "Signing in...",
    hint:
      lang === "ar"
        ? "بيانات الدخول الافتراضية: admin / admin123 (تقدر تغيّرها من ملف .env)"
        : "Default credentials: admin / admin123 (change them in .env)",
    errEmpty:
      lang === "ar"
        ? "اكتب اسم المستخدم وكلمة المرور"
        : "Enter username and password",
    errInvalid:
      lang === "ar"
        ? "اسم المستخدم أو كلمة المرور غير صحيحة"
        : "Invalid username or password",
    errServer:
      lang === "ar"
        ? "مشكلة في السيرفر — حاول تاني"
        : "Server error — try again",
    success: lang === "ar" ? "تم تسجيل الدخول" : "Logged in",
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      toast({ title: t.errEmpty, variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          lang,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        toast({
          title: lang === "ar" ? "⚠ فشل الدخول" : "⚠ Login failed",
          description: data.error || t.errInvalid,
          variant: "destructive",
        });
        setLoading(false);
        return;
      }

      toast({ title: t.success, description: data.username });
      // Give the cookie a moment to settle, then redirect
      setTimeout(() => router.replace("/"), 300);
    } catch (err: any) {
      toast({
        title: t.errServer,
        description: err?.message || "",
        variant: "destructive",
      });
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background:
          "linear-gradient(135deg, #0a0b10 0%, #161820 50%, #1a1c25 100%)",
        direction: isRTL ? "rtl" : "ltr",
      }}
    >
      <Toaster />
      {/* Lang toggle */}
      <button
        type="button"
        onClick={() => setLang(lang === "ar" ? "en" : "ar")}
        className="absolute top-4 right-4 px-3 py-1.5 rounded-md bg-white/5 border border-purple-500/20 text-gray-300 hover:bg-white/10 transition-colors text-sm flex items-center gap-1.5"
      >
        <Globe className="w-4 h-4" />
        {lang === "ar" ? "English" : "عربي"}
      </button>

      <div className="w-full max-w-md">
        {/* Logo / Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 shadow-lg shadow-purple-500/30 mb-4">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-300 to-pink-300 bg-clip-text text-transparent">
            {t.title}
          </h1>
          <p className="text-sm text-gray-400 mt-2 px-4">{t.subtitle}</p>
        </div>

        {/* Login Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-black/30 backdrop-blur-md border border-purple-500/20 rounded-2xl p-6 space-y-5 shadow-2xl"
        >
          {/* Username */}
          <div className="space-y-1.5">
            <Label htmlFor="username" className="text-gray-200">
              {t.username}
            </Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t.usernamePlaceholder}
              autoComplete="username"
              autoFocus
              disabled={loading}
              dir={isRTL ? "rtl" : "ltr"}
              className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400"
            />
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-gray-200">
              {t.password}
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.passwordPlaceholder}
                autoComplete="current-password"
                disabled={loading}
                dir={isRTL ? "rtl" : "ltr"}
                className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                className="absolute top-1/2 -translate-y-1/2 end-2 text-gray-400 hover:text-gray-200"
                aria-label="toggle password visibility"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Submit */}
          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-semibold py-2.5"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t.submitting}
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4 me-2" />
                {t.submit}
              </>
            )}
          </Button>

          {/* Hint */}
          <p className="text-xs text-gray-500 text-center pt-2 border-t border-white/5">
            {t.hint}
          </p>
        </form>
      </div>
    </div>
  );
}
