import {
  EyeOff,
  Lock,
  Moon,
  Radio,
  Smartphone,
  Sun,
  Terminal,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { VisibilityMode } from "../../shared/protocol.js";
import { AirBridgeLogo } from "./DeviceIcons.js";

interface HeaderBarProps {
  connectionState: "connecting" | "connected" | "reconnecting" | "disconnected";
  visibility: VisibilityMode;
  onChangeVisibility: (v: VisibilityMode) => void;
  simulatorOpen: boolean;
  onToggleSimulator: () => void;
  onOpenSetupGuide: () => void;
  soundMuted: boolean;
  onToggleSound: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export function HeaderBar({
  connectionState,
  visibility,
  onChangeVisibility,
  simulatorOpen,
  onToggleSimulator,
  onOpenSetupGuide,
  soundMuted,
  onToggleSound,
  darkMode,
  onToggleDarkMode,
}: HeaderBarProps) {
  const visOptions: Array<{
    id: VisibilityMode;
    label: string;
    shortLabel: string;
    icon: typeof Radio;
  }> = [
    {
      id: "nearby",
      label: "Everyone Nearby",
      shortLabel: "Nearby",
      icon: Radio,
    },
    {
      id: "paired-only",
      label: "Paired Only",
      shortLabel: "Paired",
      icon: Lock,
    },
    { id: "hidden", label: "Hidden", shortLabel: "Off", icon: EyeOff },
  ];

  return (
    <header className="sticky top-0 z-30 w-full ab-glass border-x-0 border-t-0">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        {/* Brand & E2EE Connection Pill */}
        <div className="flex items-center gap-3 min-w-0">
          <AirBridgeLogo className="w-9 h-9 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold tracking-tight text-base text-[var(--ab-text)]">
                AirBridge
              </span>
              <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/20">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    connectionState === "connected"
                      ? "bg-emerald-400"
                      : "bg-amber-400 animate-pulse"
                  }`}
                />
                {connectionState === "connected" ? "Online" : "Connecting…"}
              </span>
            </div>
            <p className="hidden md:block text-[11px] text-[var(--ab-muted)] leading-none mt-0.5">
              A bridge, not a walled garden.
            </p>
          </div>
        </div>

        {/* Center AirDrop Visibility Control */}
        <div
          role="group"
          aria-label="AirDrop Discovery Visibility"
          className="flex items-center p-1 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] border border-[var(--ab-border)]"
        >
          {visOptions.map((opt) => {
            const Icon = opt.icon;
            const active = visibility === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeVisibility(opt.id)}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                  active
                    ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-black/5 dark:border-white/10"
                    : "text-[var(--ab-muted)] hover:text-[var(--ab-text)]"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden lg:inline">{opt.label}</span>
                <span className="lg:hidden">{opt.shortLabel}</span>
              </button>
            );
          })}
        </div>

        {/* Right Utility Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={onToggleSimulator}
            title="Open an optional simulated phone in this browser — not your real phone"
            className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer ${
              simulatorOpen
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/35 shadow-sm"
                : "bg-black/[0.03] dark:bg-white/[0.04] text-[var(--ab-text-secondary)] border-[var(--ab-border)] hover:border-emerald-500/40"
            }`}
          >
            <Smartphone className="w-3.5 h-3.5 text-emerald-500" />
            <span className="hidden sm:inline">Demo phone</span>
            {simulatorOpen && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>

          <button
            type="button"
            onClick={onOpenSetupGuide}
            title="macOS CLI, Quick Actions & Android Share Sheet Setup"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium bg-black/[0.03] dark:bg-white/[0.04] text-[var(--ab-text-secondary)] border border-[var(--ab-border)] hover:text-[var(--ab-text)] transition-colors cursor-pointer"
          >
            <Terminal className="w-3.5 h-3.5 text-sky-500" />
            <span className="hidden xl:inline">How it works</span>
          </button>

          <button
            type="button"
            onClick={onToggleSound}
            aria-label={
              soundMuted ? "Unmute AirBridge chimes" : "Mute AirBridge chimes"
            }
            title={soundMuted ? "Sound Chimes Muted" : "Sound Chimes Active"}
            className="p-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] text-[var(--ab-muted)] hover:text-[var(--ab-text)] border border-[var(--ab-border)] transition-colors cursor-pointer"
          >
            {soundMuted ? (
              <VolumeX className="w-4 h-4" />
            ) : (
              <Volume2 className="w-4 h-4" />
            )}
          </button>

          <button
            type="button"
            onClick={onToggleDarkMode}
            aria-label={
              darkMode
                ? "Switch to light silver theme"
                : "Switch to dark studio theme"
            }
            title={darkMode ? "Frosted Silver Mode" : "Dark Studio Mode"}
            className="p-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] text-[var(--ab-muted)] hover:text-[var(--ab-text)] border border-[var(--ab-border)] transition-colors cursor-pointer"
          >
            {darkMode ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Moon className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
