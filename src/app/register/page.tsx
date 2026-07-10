"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Sparkles,
  Loader2,
  UserPlus,
  Eye,
  EyeOff,
  Globe,
  LogIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";

/**
 * Register page — multi-user signup.
 * Bilingual (ar/en) — defaults to Arabic, RTL.
 */
export default function RegisterPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
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
    title: lang === "ar" ? "إنشاء حساب جديد" : "Create Account",
    subtitle:
      lang === "ar"
        ? "اعمل حسابك الخاص على استوديو الشخصيات المتكلمة"
        : "Sign up for your own Talking Characters Studio account",
    username: lang === "ar" ? "اسم المستخدم" : "Username",
    usernamePlaceholder:
      lang === "ar" ? "3–32 حرف، حروف وأرقام و _ و -" : "3–32 chars, letters/digits/_/-",
    displayName: lang === "ar" ? "الاسم المعروض (اختياري)" : "Display name (optional)",
    displayNamePlaceholder:
      lang === "ar" ? "الاسم اللي هيظهر في الـ header" : "Name shown in the header",
    password: lang === "ar" ? "كلمة المرور" : "Password",
    passwordPlaceholder:
      lang === "ar" ? "6 حروف على الأقل" : "At least 6 characters",
    confirmPassword: lang === "ar" ? "تأكيد كلمة المرور" : "Confirm password",
    confirmPasswordPlaceholder: lang === "ar" ? "أعد كتابة كلمة المرور" : "Re-enter password",
    submit: lang === "ar" ? "إنشاء الحساب" : "Create Account",
    submitting: lang === "ar" ? "جاري الإنشاء..." : "Creating...",
    haveAccount: lang === "ar" ? "عندك حساب بالفعل؟" : "Already have an account?",
    signIn: lang === "ar" ? "سجّل دخول" : "Sign in",
    errEmpty: lang === "ar" ? "اكتب اسم المستخدم وكلمة المرور" : "Enter username and password",
    errMatch: lang === "ar" ? "كلمتا المرور مش متطابقين" : "Passwords don't match",
    errShort: lang === "ar" ? "كلمة المرور قصيرة جداً (6 على الأقل)" : "Password too short (min 6)",
    success: lang === "ar" ? "تم إنشاء الحساب" : "Account created",
    errServer: lang === "ar" ? "مشكلة في السيرفر — حاول تاني" : "Server error — try again",
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!username.trim() || !password) {
      toast({ title: t.errEmpty, variant: "destructive" });
      return;
    }
    if (password.length < 6) {
      toast({ title: t.errShort, variant: "destructive" });
      return;
    }
    if (password !== confirmPassword) {
      toast({ title: t.errMatch, variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          displayName: displayName.trim(),
          lang,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        toast({
          title: lang === "ar" ? "⚠ فشل التسجيل" : "⚠ Registration failed",
          description: data.error || "",
          variant: "destructive",
        });
        setLoading(false);
        return;
      }

      toast({
        title: t.success,
        description:
          lang === "ar"
            ? `أهلاً ${data.user?.username || username}!`
            : `Welcome, ${data.user?.username || username}!`,
      });
      // Give the cookie a moment to settle, then redirect
      setTimeout(() => router.replace("/"), 350);
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

        {/* Register Card */}
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
              dir="ltr"
              className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 text-left"
            />
          </div>

          {/* Display name (optional) */}
          <div className="space-y-1.5">
            <Label htmlFor="displayName" className="text-gray-200">
              {t.displayName}
            </Label>
            <Input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t.displayNamePlaceholder}
              autoComplete="nickname"
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
                autoComplete="new-password"
                disabled={loading}
                dir="ltr"
                className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 pr-10 text-left"
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

          {/* Confirm password */}
          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword" className="text-gray-200">
              {t.confirmPassword}
            </Label>
            <Input
              id="confirmPassword"
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t.confirmPasswordPlaceholder}
              autoComplete="new-password"
              disabled={loading}
              dir="ltr"
              className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 text-left"
            />
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
                <UserPlus className="w-4 h-4 me-2" />
                {t.submit}
              </>
            )}
          </Button>

          {/* Have account? Sign in */}
          <div className="text-center pt-2 border-t border-white/5">
            <span className="text-sm text-gray-400">{t.haveAccount} </span>
            <Link
              href="/login"
              className="text-sm text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              <LogIn className="w-3.5 h-3.5" />
              {t.signIn}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
