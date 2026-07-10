"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Sparkles,
  Loader2,
  LogIn,
  Eye,
  EyeOff,
  Globe,
  UserPlus,
  Mail,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";

/**
 * Login page — multi-user auth.
 * Login identifier is the email (username is also accepted as a fallback).
 *
 * Bilingual (ar/en) — defaults to Arabic, RTL.
 */
export default function LoginPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
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
    email: lang === "ar" ? "البريد الإلكتروني" : "Email",
    emailPlaceholder: lang === "ar" ? "you@example.com" : "you@example.com",
    password: lang === "ar" ? "رقم السر" : "Password",
    passwordPlaceholder: lang === "ar" ? "اكتب رقم السر" : "Enter password",
    submit: lang === "ar" ? "دخول" : "Sign In",
    submitting: lang === "ar" ? "جاري الدخول..." : "Signing in...",
    noAccount: lang === "ar" ? "معندكش حساب؟" : "Don't have an account?",
    signUp: lang === "ar" ? "اعمل حساب جديد" : "Sign up",
    errEmpty:
      lang === "ar"
        ? "اكتب البريد الإلكتروني ورقم السر"
        : "Enter email and password",
    errInvalid:
      lang === "ar"
        ? "البريد الإلكتروني أو رقم السر غير صحيح"
        : "Invalid email or password",
    errServer:
      lang === "ar" ? "مشكلة في السيرفر — حاول تاني" : "Server error — try again",
    success: lang === "ar" ? "تم تسجيل الدخول" : "Logged in",
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast({ title: t.errEmpty, variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
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

      toast({ title: t.success, description: data.displayName || data.username });
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
                autoFocus
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
                autoComplete="current-password"
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

          {/* Sign up link */}
          <div className="text-center pt-2 border-t border-white/5">
            <span className="text-sm text-gray-400">{t.noAccount} </span>
            <Link
              href="/register"
              className="text-sm text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              <UserPlus className="w-3.5 h-3.5" />
              {t.signUp}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
