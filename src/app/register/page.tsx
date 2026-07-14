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
  Mail,
  User as UserIcon,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";
import PWAGuard from "@/components/PWAGuard";

/**
 * Register page — multi-user signup.
 * Fields: name (display name, any language) + email + password.
 *
 * Bilingual (ar/en) — defaults to Arabic, RTL.
 */
export default function RegisterPage() {
  return (
    <PWAGuard>
      <RegisterPageInner />
    </PWAGuard>
  );
}

function RegisterPageInner() {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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
    name: lang === "ar" ? "الاسم" : "Name",
    namePlaceholder:
      lang === "ar"
        ? "اسمك (بالعربي أو الإنجليزي)"
        : "Your name (Arabic or English)",
    email: lang === "ar" ? "البريد الإلكتروني" : "Email",
    emailPlaceholder: lang === "ar" ? "you@example.com" : "you@example.com",
    password: lang === "ar" ? "رقم السر" : "Password",
    passwordPlaceholder:
      lang === "ar" ? "6 حروف على الأقل" : "At least 6 characters",
    confirmPassword: lang === "ar" ? "تأكيد رقم السر" : "Confirm password",
    confirmPasswordPlaceholder:
      lang === "ar" ? "أعد كتابة رقم السر" : "Re-enter password",
    submit: lang === "ar" ? "إنشاء الحساب" : "Create Account",
    submitting: lang === "ar" ? "جاري الإنشاء..." : "Creating...",
    haveAccount: lang === "ar" ? "عندك حساب بالفعل؟" : "Already have an account?",
    signIn: lang === "ar" ? "سجّل دخول" : "Sign in",
    errEmpty: lang === "ar" ? "اكتب البريد ورقم السر" : "Enter email and password",
    errMatch: lang === "ar" ? "رقم السر مش متطابق" : "Passwords don't match",
    errShort: lang === "ar" ? "رقم السر قصير جداً (6 على الأقل)" : "Password too short (min 6)",
    errEmail: lang === "ar" ? "اكتب بريد إلكتروني صحيح" : "Enter a valid email",
    success: lang === "ar" ? "تم إنشاء الحساب" : "Account created",
    errServer: lang === "ar" ? "مشكلة في السيرفر — حاول تاني" : "Server error — try again",
    google: lang === "ar" ? "الاشتراك بحساب جوجل" : "Sign up with Google",
    or: lang === "ar" ? "أو" : "or",
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!email.trim() || !password) {
      toast({ title: t.errEmpty, variant: "destructive" });
      return;
    }
    // Basic email check on client side too
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast({ title: t.errEmail, variant: "destructive" });
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
          name: name.trim(),
          email: email.trim(),
          password,
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
            ? `أهلاً ${data.user?.displayName || name || email}!`
            : `Welcome, ${data.user?.displayName || name || email}!`,
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
          {/* Google OAuth button */}
          <a
            href="/api/auth/google"
            className="w-full flex items-center justify-center gap-2.5 bg-white hover:bg-gray-100 text-gray-800 font-semibold py-2.5 rounded-md border border-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            {t.google}
          </a>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-gray-500 uppercase">{t.or}</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* Name (display name — any language) */}
          <div className="space-y-1.5">
            <Label htmlFor="name" className="text-gray-200">
              {t.name}
            </Label>
            <div className="relative">
              <UserIcon className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-gray-500" />
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.namePlaceholder}
                autoComplete="name"
                autoFocus
                disabled={loading}
                dir={isRTL ? "rtl" : "ltr"}
                className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 ps-10"
              />
            </div>
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-gray-200">
              {t.email}
            </Label>
            <div className="relative">
              <Mail className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-gray-500" />
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.emailPlaceholder}
                autoComplete="email"
                disabled={loading}
                dir="ltr"
                className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 ps-10 text-left"
              />
            </div>
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-gray-200">
              {t.password}
            </Label>
            <div className="relative">
              <Lock className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-gray-500" />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.passwordPlaceholder}
                autoComplete="new-password"
                disabled={loading}
                dir="ltr"
                className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 ps-10 pe-10 text-left"
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
            <div className="relative">
              <Lock className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-gray-500" />
              <Input
                id="confirmPassword"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t.confirmPasswordPlaceholder}
                autoComplete="new-password"
                disabled={loading}
                dir="ltr"
                className="bg-black/40 border-purple-500/30 text-gray-100 placeholder-gray-500 focus:border-purple-400 ps-10 text-left"
              />
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
