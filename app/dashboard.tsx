"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, CircleAlert, CloudSun, Download, ExternalLink, Gauge, Globe2,
  LoaderCircle, Maximize2, Pause, Play, Radio, RefreshCw, RotateCcw,
  Satellite, SkipBack, SkipForward, Sun, Zap, ZoomIn, ZoomOut,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createGifFromImageUrls, triggerDownload } from "@/lib/export-gif";

const SWPC = "https://services.swpc.noaa.gov";
const STAR = "https://cdn.star.nesdis.noaa.gov";

type ViewMode = "earth" | "lightning" | "sun" | "aurora" | "telemetry";
type TelemetryMode = "xray" | "proton" | "wind" | "kp";
type Frame = { url: string; time?: string };
type Point = { time: number; label: string; value: number; value2?: number };
type AlertItem = { product_id: string; issue_datetime: string; message: string };

const earthLayers = [
  ["GEOCOLOR", "GeoColor", "Daylight color + nighttime IR"],
  ["13", "Clean IR", "Cloud-top temperature · 10.3 µm"],
  ["09", "Water vapor", "Mid-level moisture · 6.9 µm"],
  ["AirMass", "Air mass", "RGB air-mass boundaries"],
  ["Dust", "Dust", "Dust and dry-air RGB"],
  ["FireTemperature", "Fire temp", "Shortwave fire hot spots"],
  ["Sandwich", "Sandwich", "Visible + infrared composite"],
] as const;

const solarLayers = [
  ["195", "195 Å", "Quiet corona · ~1.5 MK"],
  ["304", "304 Å", "Chromosphere · ~50,000 K"],
  ["171", "171 Å", "Coronal loops · ~0.6 MK"],
  ["131", "131 Å", "Flares · hot plasma"],
  ["094", "94 Å", "Active corona · ~6 MK"],
  ["284", "284 Å", "Active regions · ~2 MK"],
  ["ccor1", "CCOR-1", "GOES-19 outer corona"],
  ["ccor2", "CCOR-2", "SOLAR-1 outer corona"],
  ["lasco-c3", "LASCO C3", "Wide-field corona"],
] as const;

const lightningLayers = [
  ["EXTENT3", "Flash extent", "Flash extent density over recent imagery"],
  ["COUNTS", "Flash count", "Lightning activity and concentration"],
  ["ENERGY", "Optical energy", "Total lightning optical energy"],
] as const;

const telemetryLayers = [
  ["xray", "X-ray flux", "GOES 0.1–0.8 nm"],
  ["proton", "Proton flux", "GOES ≥10 MeV"],
  ["wind", "Solar wind", "SOLAR-1 speed + Bz"],
  ["kp", "Planetary Kp", "Geomagnetic activity"],
] as const;

function parseEarthTime(filename: string) {
  const match = filename.match(/^(\d{4})(\d{3})(\d{2})(\d{2})_/);
  if (!match) return undefined;
  const [, year, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), 0, 1, Number(hour), Number(minute)));
  date.setUTCDate(Number(day));
  return date.toISOString();
}

function frameTime(frame?: Frame) {
  if (!frame?.time) return "Latest available";
  const date = new Date(frame.time.endsWith("Z") ? frame.time : `${frame.time}Z`);
  return Number.isNaN(date.getTime()) ? frame.time : date.toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

function flareClass(flux?: number) {
  if (!flux || flux <= 0) return "—";
  const levels = [[1e-4, "X"], [1e-5, "M"], [1e-6, "C"], [1e-7, "B"], [1e-8, "A"]] as const;
  for (const [base, name] of levels) if (flux >= base) return `${name}${(flux / base).toFixed(1)}`;
  return `A${(flux / 1e-8).toFixed(1)}`;
}

function shortTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function thin<T>(items: T[], max = 240) {
  if (items.length <= max) return items;
  const step = Math.ceil(items.length / max);
  return items.filter((_, index) => index % step === 0 || index === items.length - 1);
}

export default function Dashboard() {
  const [mode, setMode] = useState<ViewMode>("earth");
  const [satelliteId, setSatelliteId] = useState<"19" | "18">("19");
  const [region, setRegion] = useState<"CONUS" | "ARIZONA" | "FD">("CONUS");
  const [earthLayer, setEarthLayer] = useState("GEOCOLOR");
  const [lightningLayer, setLightningLayer] = useState("EXTENT3");
  const [solarLayer, setSolarLayer] = useState("195");
  const [hemisphere, setHemisphere] = useState<"north" | "south">("north");
  const [telemetryMode, setTelemetryMode] = useState<TelemetryMode>("xray");
  const [frames, setFrames] = useState<Frame[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackFps, setPlaybackFps] = useState(5);
  const [buffering, setBuffering] = useState(false);
  const [preparedFrames, setPreparedFrames] = useState(0);
  const [loadingFrames, setLoadingFrames] = useState(true);
  const [frameError, setFrameError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [clock, setClock] = useState(new Date());
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [xray, setXray] = useState<Point[]>([]);
  const [protons, setProtons] = useState<Point[]>([]);
  const [wind, setWind] = useState<Point[]>([]);
  const [kp, setKp] = useState<Point[]>([]);
  const [telemetryLoading, setTelemetryLoading] = useState(true);
  const [exportingGif, setExportingGif] = useState(false);
  const [gifProgress, setGifProgress] = useState(0);
  const [gifStatus, setGifStatus] = useState("");
  const viewerRef = useRef<HTMLDivElement>(null);
  const frameIndexRef = useRef(0);
  const imageCacheRef = useRef(new Map<string, Promise<boolean>>());

  const preloadImage = useCallback((url: string) => {
    const cached = imageCacheRef.current.get(url);
    if (cached) return cached;
    const request = new Promise<boolean>((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(true);
      image.onerror = () => {
        imageCacheRef.current.delete(url);
        resolve(false);
      };
      image.src = url;
    });
    imageCacheRef.current.set(url, request);
    return request;
  }, []);

  const goToFrame = useCallback((index: number) => {
    const bounded = Math.max(0, Math.min(index, Math.max(0, frames.length - 1)));
    frameIndexRef.current = bounded;
    setFrameIndex(bounded);
  }, [frames.length]);

  const loadFrames = useCallback(async () => {
    if (mode === "telemetry") return;
    setLoadingFrames(true); setFrameError(""); setPlaying(false); setZoom(1);
    try {
      let nextFrames: Frame[] = [];
      if (mode === "earth" || mode === "lightning") {
        const isArizona = region === "ARIZONA";
        const sourceRegion = isArizona
          ? `SECTOR/${satelliteId === "19" ? "sr" : "psw"}`
          : region;
        const size = isArizona ? "1200x1200" : region === "CONUS" ? "1250x750" : "1808x1808";
        const base = mode === "lightning"
          ? `${STAR}/GOES${satelliteId}/GLM/${sourceRegion}/${lightningLayer}/`
          : `${STAR}/GOES${satelliteId}/ABI/${sourceRegion}/${earthLayer}/`;
        const fallbackFrame = { url: `${base}${size}.jpg`, time: new Date().toISOString() };
        setFrames([fallbackFrame]);
        frameIndexRef.current = 0;
        setFrameIndex(0);
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 8000);
        try {
          const html = await fetch(`${base}?v=${Date.now()}`, { signal: controller.signal }).then((r) => {
            if (!r.ok) throw new Error("NOAA imagery is temporarily unavailable");
            return r.text();
          });
          const expression = new RegExp(`href="([0-9][^"]*-${size}\\.jpg)"`, "g");
          const names = Array.from(html.matchAll(expression), (match) => match[1]);
          nextFrames = names.slice(-48).map((name) => ({ url: `${base}${name}`, time: parseEarthTime(name) }));
        } catch {
          // NOAA's directory listing can occasionally stall even when its current image is available.
        } finally {
          window.clearTimeout(timeout);
        }
        if (!nextFrames.length) nextFrames = [fallbackFrame];
      } else if (mode === "sun") {
        let endpoint = `/products/animations/suvi-primary-${solarLayer}.json`;
        if (solarLayer === "ccor1") endpoint = "/products/animations/ccor1/ccor1.json";
        if (solarLayer === "ccor2") endpoint = "/products/animations/ccor2/ccor2.json";
        if (solarLayer === "lasco-c3") endpoint = "/products/animations/lasco-c3.json";
        const data = await fetch(`${SWPC}${endpoint}?v=${Date.now()}`).then((r) => {
          if (!r.ok) throw new Error("Solar imagery is temporarily unavailable");
          return r.json();
        });
        nextFrames = data.slice(-72).map((item: { url: string; time_tag?: string }) => ({
          url: item.url.startsWith("http") ? item.url : `${SWPC}${item.url}`, time: item.time_tag,
        }));
      } else {
        const endpoint = `/products/animations/ovation_${hemisphere}_24h.json`;
        const data = await fetch(`${SWPC}${endpoint}?v=${Date.now()}`).then((r) => {
          if (!r.ok) throw new Error("Aurora imagery is temporarily unavailable");
          return r.json();
        });
        nextFrames = data.slice(-72).map((item: { url: string; time_tag?: string }) => ({
          url: item.url.startsWith("http") ? item.url : `${SWPC}${item.url}`, time: item.time_tag,
        }));
      }
      const newest = Math.max(0, nextFrames.length - 1);
      setFrames(nextFrames); frameIndexRef.current = newest; setFrameIndex(newest);
      setPlaying(nextFrames.length > 1);
    } catch (error) {
      setFrames([]); setFrameError(error instanceof Error ? error.message : "Unable to load this NOAA feed");
    } finally { setLoadingFrames(false); }
  }, [mode, satelliteId, region, earthLayer, lightningLayer, solarLayer, hemisphere]);

  useEffect(() => { void loadFrames(); }, [loadFrames, refreshKey]);
  useEffect(() => { frameIndexRef.current = frameIndex; }, [frameIndex]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPreparedFrames(0);
    if (!frames.length) return;

    const newest = frames.length - 1;
    const priority = [newest, ...frames.map((_, index) => index)].filter((index, position, values) => values.indexOf(index) === position);
    async function prepareAnimation() {
      let prepared = 0;
      for (let start = 0; start < priority.length && !cancelled; start += 3) {
        const batch = priority.slice(start, start + 3);
        const results = await Promise.all(batch.map((index) => preloadImage(frames[index].url)));
        if (cancelled) return;
        prepared += results.filter(Boolean).length;
        setPreparedFrames(prepared);
      }
    }
    void prepareAnimation();
    return () => { cancelled = true; };
  }, [frames, preloadImage]);

  useEffect(() => {
    if (!frames.length) return;
    for (let offset = 1; offset <= 4; offset += 1) {
      void preloadImage(frames[(frameIndex + offset) % frames.length].url);
    }
  }, [frameIndex, frames, preloadImage]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    let cancelled = false;
    let timer = 0;
    const interval = 1000 / playbackFps;

    async function advance() {
      const next = (frameIndexRef.current + 1) % frames.length;
      const bufferingTimer = window.setTimeout(() => {
        if (!cancelled) setBuffering(true);
      }, 140);
      const ready = await preloadImage(frames[next].url);
      window.clearTimeout(bufferingTimer);
      if (cancelled) return;
      setBuffering(false);
      if (ready) goToFrame(next);
      timer = window.setTimeout(advance, ready ? interval : 600);
    }

    timer = window.setTimeout(advance, interval);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setBuffering(false);
    };
  }, [playing, frames, playbackFps, preloadImage, goToFrame]);

  useEffect(() => {
    const handleVisibility = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const togglePlayback = useCallback(() => {
    if (playing) { setPlaying(false); return; }
    if (frameIndexRef.current === frames.length - 1) goToFrame(0);
    setPlaying(true);
  }, [playing, frames.length, goToFrame]);

  const stepFrame = useCallback((direction: -1 | 1) => {
    setPlaying(false);
    if (!frames.length) return;
    goToFrame((frameIndexRef.current + direction + frames.length) % frames.length);
  }, [frames.length, goToFrame]);

  useEffect(() => {
    let cancelled = false;
    async function loadTelemetry() {
      setTelemetryLoading(true);
      try {
        const [xrayRaw, protonRaw, windRaw, magRaw, kpRaw, alertRaw] = await Promise.all([
          fetch(`${SWPC}/json/goes/primary/xrays-6-hour.json`).then((r) => r.json()),
          fetch(`${SWPC}/json/goes/primary/integral-protons-6-hour.json`).then((r) => r.json()),
          fetch(`${SWPC}/json/rtsw/rtsw_wind_1m.json`).then((r) => r.json()),
          fetch(`${SWPC}/json/rtsw/rtsw_mag_1m.json`).then((r) => r.json()),
          fetch(`${SWPC}/json/planetary_k_index_1m.json`).then((r) => r.json()),
          fetch(`${SWPC}/products/alerts.json`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        const makePoints = (raw: Array<Record<string, unknown>>, field: string) => thin(raw.map((item) => ({
          time: new Date(String(item.time_tag).endsWith("Z") ? String(item.time_tag) : `${item.time_tag}Z`).getTime(),
          label: String(item.time_tag), value: Number(item[field]),
        })).filter((item) => item.time >= sixHoursAgo && Number.isFinite(item.value)).sort((a, b) => a.time - b.time));
        setXray(makePoints(xrayRaw.filter((item: { energy: string }) => item.energy === "0.1-0.8nm"), "flux"));
        setProtons(makePoints(protonRaw.filter((item: { energy: string }) => item.energy === ">=10 MeV"), "flux"));
        const activeWind = windRaw.filter((item: { active: boolean; source: string }) => item.active && item.source === "SOLAR1");
        const activeMag = magRaw.filter((item: { active: boolean; source: string }) => item.active && item.source === "SOLAR1");
        const bzByMinute = new Map(activeMag.map((item: { time_tag: string; bz_gsm: number }) => [item.time_tag.slice(0, 16), item.bz_gsm]));
        setWind(thin(activeWind.map((item: { time_tag: string; proton_speed: number }) => ({
          time: new Date(`${item.time_tag}Z`).getTime(), label: item.time_tag, value: item.proton_speed,
          value2: bzByMinute.get(item.time_tag.slice(0, 16)),
        })).filter((item: Point) => item.time >= sixHoursAgo && Number.isFinite(item.value)).sort((a: Point, b: Point) => a.time - b.time)));
        setKp(makePoints(kpRaw, "estimated_kp"));
        setAlerts(alertRaw.slice(0, 6));
      } catch { if (!cancelled) setAlerts([]); }
      finally { if (!cancelled) setTelemetryLoading(false); }
    }
    void loadTelemetry();
    const timer = window.setInterval(loadTelemetry, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [refreshKey]);

  useEffect(() => {
    const context = typeof document === "undefined" ? undefined : (document as Document & {
      modelContext?: { registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void> };
    }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Record<string, unknown>) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined); } catch {}
    };
    register({
      name: "set_noaa_view", title: "Set NOAA viewer",
      description: "Switch the visible NOAA dashboard between Earth, lightning, Sun, aurora, and telemetry.",
      inputSchema: { type: "object", properties: { view: { type: "string", enum: ["earth", "lightning", "sun", "aurora", "telemetry"] } }, required: ["view"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        const value = (input as { view?: ViewMode })?.view;
        if (!value || !["earth", "lightning", "sun", "aurora", "telemetry"].includes(value)) throw new Error("Invalid view");
        setMode(value); return { view: value };
      },
    });
    register({
      name: "set_goes_coverage", title: "Set GOES coverage",
      description: "Change the Earth imagery coverage to the continental U.S., Arizona, or full disk.",
      inputSchema: { type: "object", properties: { coverage: { type: "string", enum: ["CONUS", "ARIZONA", "FD"] } }, required: ["coverage"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        const coverage = (input as { coverage?: "CONUS" | "ARIZONA" | "FD" })?.coverage;
        if (!coverage || !["CONUS", "ARIZONA", "FD"].includes(coverage)) throw new Error("Invalid coverage");
        setMode("earth"); setRegion(coverage); return { view: "earth", coverage };
      },
    });
    register({
      name: "control_noaa_timeline", title: "Control NOAA timeline",
      description: "Play, pause, or jump to the newest frame in the visible NOAA imagery timeline.",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "latest"] } }, required: ["action"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        const action = (input as { action?: string })?.action;
        if (action === "play") setPlaying(true);
        else if (action === "pause") setPlaying(false);
        else if (action === "latest") { setPlaying(false); setFrameIndex(Math.max(0, frames.length - 1)); }
        else throw new Error("Invalid action");
        return { action, frame: action === "latest" ? Math.max(0, frames.length - 1) : frameIndex };
      },
    });
    return () => lifecycle.abort();
  }, [frames.length, frameIndex]);

  const currentFrame = frames[frameIndex];
  const latestXray = xray.at(-1)?.value, latestProton = protons.at(-1)?.value;
  const latestWind = wind.at(-1)?.value, latestBz = wind.at(-1)?.value2, latestKp = kp.at(-1)?.value;
  const activeLayer = useMemo(() => {
    if (mode === "earth") return earthLayers.find(([key]) => key === earthLayer)?.[1];
    if (mode === "lightning") return lightningLayers.find(([key]) => key === lightningLayer)?.[1];
    if (mode === "sun") return solarLayers.find(([key]) => key === solarLayer)?.[1];
    if (mode === "aurora") return hemisphere === "north" ? "Northern hemisphere" : "Southern hemisphere";
    return telemetryLayers.find(([key]) => key === telemetryMode)?.[1];
  }, [mode, earthLayer, lightningLayer, solarLayer, hemisphere, telemetryMode]);

  const handleDownloadGif = useCallback(async () => {
    if (exportingGif || !frames.length) return;
    setExportingGif(true);
    setGifProgress(0);
    setGifStatus("Preparing frames...");

    try {
      const urls = frames.map((f) => f.url);
      const blob = await createGifFromImageUrls({
        urls,
        fps: playbackFps,
        maxDimension: 720,
        onProgress: (progress, _stage, detail) => {
          setGifProgress(progress);
          if (detail) setGifStatus(detail);
        },
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const layerName = (activeLayer || mode).toLowerCase().replace(/[^a-z0-9_-]/gi, "-");
      const filename = `noaa-${mode}-${layerName}-${playbackFps}fps-${timestamp}.gif`;

      triggerDownload(blob, filename);
    } catch (err) {
      console.error("Failed to export GIF:", err);
      alert(err instanceof Error ? err.message : "Failed to generate GIF");
    } finally {
      setExportingGif(false);
      setGifProgress(0);
      setGifStatus("");
    }
  }, [exportingGif, frames, playbackFps, mode, activeLayer]);

  const tabItems = [["earth", "Earth", Globe2], ["lightning", "Lightning", Zap], ["sun", "Sun", Sun], ["aurora", "Aurora", CloudSun], ["telemetry", "Telemetry", Activity]] as const;

  return (
    <main className="min-h-screen bg-[#f3f5f7] text-slate-900">
      <header className="sticky top-0 z-40 flex min-h-16 flex-wrap items-center border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur-xl sm:h-16 sm:flex-nowrap sm:py-0 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#0b5cab] text-white"><Satellite className="size-[19px]" /></div>
          <div className="min-w-0"><h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">NOAA Viewer</h1><p className="hidden text-xs text-slate-500 sm:block">Satellite and space weather</p></div>
        </div>
        <Tabs value={mode} onValueChange={(value) => setMode(value as ViewMode)} className="order-3 mt-2 w-full sm:order-none sm:mx-auto sm:mt-0 sm:w-auto">
          <TabsList className="grid h-11 w-full grid-cols-5 gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-1 sm:h-10 sm:w-auto">
            {tabItems.map(([value, label, Icon]) => <TabsTrigger key={value} value={value} className="h-9 min-w-0 flex-col gap-0.5 rounded-md px-0.5 text-[10px] leading-none text-slate-600 data-[state=active]:bg-white data-[state=active]:text-[#0b5cab] data-[state=active]:shadow-sm sm:h-8 sm:flex-row sm:px-3 sm:text-sm lg:px-4"><Icon className="size-3.5" /><span>{label}</span></TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center justify-end gap-3 text-right sm:ml-0">
          <div className="hidden md:block"><p className="font-mono text-xs text-slate-700">{clock.toISOString().slice(11, 19)} UTC</p><p className="text-[11px] text-slate-400">updates automatically</p></div>
          <Button variant="outline" size="icon-sm" aria-label="Refresh all data" className="border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw className="size-3.5" /></Button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-7.25rem)] grid-cols-1 sm:min-h-[calc(100vh-4rem)] xl:grid-cols-[244px_minmax(0,1fr)_290px]">
        <aside className="border-b border-slate-200 bg-white p-4 xl:border-b-0 xl:border-r xl:p-5">
          <div className="flex items-center justify-between xl:block"><div><p className="eyebrow">Observation</p><h2 className="mt-1 text-lg font-semibold">{activeLayer}</h2></div><div className="live-chip xl:mt-4"><span /> LIVE</div></div>
          {mode === "earth" && <div className="mt-5 space-y-6">
            <div><label className="control-label">Satellite</label><div className="grid grid-cols-2 gap-2">{(["19", "18"] as const).map((id) => <button key={id} onClick={() => setSatelliteId(id)} className={`segment ${satelliteId === id ? "active" : ""}`}><span>GOES-{id}</span><small>{id === "19" ? "East" : "West"}</small></button>)}</div></div>
            <div><label className="control-label">Coverage</label><div className="grid grid-cols-3 gap-2"><button onClick={() => setRegion("CONUS")} className={`segment compact ${region === "CONUS" ? "active" : ""}`}>CONUS</button><button onClick={() => setRegion("ARIZONA")} className={`segment compact ${region === "ARIZONA" ? "active" : ""}`}>Arizona</button><button onClick={() => setRegion("FD")} className={`segment compact ${region === "FD" ? "active" : ""}`}>Full disk</button></div></div>
            <LayerList items={earthLayers} value={earthLayer} onChange={setEarthLayer} />
          </div>}
          {mode === "lightning" && <div className="mt-5 space-y-6">
            <div><label className="control-label">Satellite</label><div className="grid grid-cols-2 gap-2">{(["19", "18"] as const).map((id) => <button key={id} onClick={() => setSatelliteId(id)} className={`segment ${satelliteId === id ? "active" : ""}`}><span>GOES-{id}</span><small>{id === "19" ? "East" : "West"}</small></button>)}</div></div>
            <div><label className="control-label">Coverage</label><div className="grid grid-cols-3 gap-2"><button onClick={() => setRegion("CONUS")} className={`segment compact ${region === "CONUS" ? "active" : ""}`}>CONUS</button><button onClick={() => setRegion("ARIZONA")} className={`segment compact ${region === "ARIZONA" ? "active" : ""}`}>Arizona</button><button onClick={() => setRegion("FD")} className={`segment compact ${region === "FD" ? "active" : ""}`}>Full disk</button></div></div>
            <LayerList items={lightningLayers} value={lightningLayer} onChange={setLightningLayer} />
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-600">GLM detects optical lightning from cloud top, including in-cloud activity that ground strike maps may miss.</div>
          </div>}
          {mode === "sun" && <div className="mt-5"><LayerList items={solarLayers} value={solarLayer} onChange={setSolarLayer} /></div>}
          {mode === "aurora" && <div className="mt-5 space-y-6">
            <div><label className="control-label">Hemisphere</label><div className="grid grid-cols-2 gap-2"><button onClick={() => setHemisphere("north")} className={`segment compact ${hemisphere === "north" ? "active" : ""}`}>North</button><button onClick={() => setHemisphere("south")} className={`segment compact ${hemisphere === "south" ? "active" : ""}`}>South</button></div></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-600">NOAA OVATION estimates auroral intensity from current solar-wind conditions. Forecast frames extend about 30 minutes ahead.</div>
          </div>}
          {mode === "telemetry" && <div className="mt-5"><LayerList items={telemetryLayers} value={telemetryMode} onChange={(value) => setTelemetryMode(value as TelemetryMode)} /></div>}
          <div className="mt-7 hidden border-t border-slate-200 pt-5 text-xs leading-relaxed text-slate-500 xl:block">Data are provided by NOAA/NESDIS and the Space Weather Prediction Center. Times are shown in UTC or your local timezone as labeled.</div>
        </aside>

        <section className="min-w-0 bg-[#f3f5f7] p-3 sm:p-5 lg:p-6">
          {mode === "telemetry" ? <TelemetryPanel mode={telemetryMode} xray={xray} protons={protons} wind={wind} kp={kp} loading={telemetryLoading} /> : <>
            <div ref={viewerRef} className="viewer-shell">
              <div className="viewer-topbar">
                <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{mode === "earth" ? `GOES-${satelliteId} · ${region === "ARIZONA" ? "Arizona focus" : region}` : mode === "lightning" ? `GOES-${satelliteId} GLM · ${region === "ARIZONA" ? "Arizona focus" : region}` : mode === "sun" ? "Solar observation" : "Auroral forecast"}</p><p className="truncate font-mono text-[11px] text-slate-500">{frameTime(currentFrame)}</p></div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label="Zoom out" className="viewer-button" onClick={() => setZoom((value) => Math.max(0.7, value - 0.2))}><ZoomOut /></Button>
                  <span className="w-10 text-center font-mono text-[10px] text-slate-500">{Math.round(zoom * 100)}%</span>
                  <Button variant="ghost" size="icon-sm" aria-label="Zoom in" className="viewer-button" onClick={() => setZoom((value) => Math.min(3, value + 0.2))}><ZoomIn /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Reset zoom" className="viewer-button hidden sm:inline-flex" onClick={() => setZoom(1)}><RotateCcw /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Open full screen" className="viewer-button" onClick={() => viewerRef.current?.requestFullscreen()}><Maximize2 /></Button>
                </div>
              </div>
              <div className="relative flex min-h-[370px] flex-1 items-center justify-center overflow-auto bg-black sm:min-h-[500px]">
                {loadingFrames && !currentFrame && <div className="loading-state"><LoaderCircle className="size-5 animate-spin" /><span>Acquiring NOAA feed</span></div>}
                {!loadingFrames && frameError && <div className="max-w-sm p-8 text-center"><CircleAlert className="mx-auto mb-3 size-6 text-amber-500" /><p className="text-sm text-slate-300">{frameError}</p><button className="mt-3 text-xs text-blue-400 hover:underline" onClick={loadFrames}>Try again</button></div>}
                {currentFrame && <img src={currentFrame.url} decoding="async" alt={`${activeLayer} NOAA observation at ${frameTime(currentFrame)}`} className={`noaa-frame block max-h-[68vh] max-w-full object-contain transition-transform duration-200 ${mode === "sun" ? "solar-frame" : ""}`} style={{ transform: `scale(${zoom})` }} />}
                {buffering && <div className="buffering-chip"><LoaderCircle className="size-3 animate-spin" /> Buffering next frame</div>}
                <div className="absolute bottom-3 left-3 rounded-md border border-white/10 bg-black/60 px-2.5 py-1.5 font-mono text-[10px] text-slate-300 backdrop-blur-md">{activeLayer} · frame {frames.length ? frameIndex + 1 : 0}/{frames.length}</div>
              </div>
            </div>
            <div className="timeline-panel">
              <div className="playback-controls">
                <Button variant="ghost" size="icon-sm" className="viewer-button" aria-label="Previous frame" disabled={frames.length < 2} onClick={() => stepFrame(-1)}><SkipBack /></Button>
                <Button aria-label={playing ? "Pause animation" : "Play animation"} size="icon" className="size-10 rounded-lg bg-[#0b5cab] text-white hover:bg-[#084a8c]" disabled={frames.length < 2} onClick={togglePlayback}>{playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}</Button>
                <Button variant="ghost" size="icon-sm" className="viewer-button" aria-label="Next frame" disabled={frames.length < 2} onClick={() => stepFrame(1)}><SkipForward /></Button>
              </div>
              <div className="min-w-0 flex-1"><Slider aria-label="Observation timeline" min={0} max={Math.max(0, frames.length - 1)} step={1} value={[frameIndex]} disabled={!frames.length} onValueChange={(value) => { setPlaying(false); goToFrame(value[0] ?? 0); }} className="[&_[data-slot=slider-range]]:bg-[#0b5cab] [&_[data-slot=slider-thumb]]:border-[#0b5cab] [&_[data-slot=slider-track]]:bg-slate-200" /><div className="mt-2 flex justify-between font-mono text-[10px] text-slate-500"><span>{frameTime(frames[0])}</span><span>{exportingGif ? `${gifStatus} (${gifProgress}%)` : preparedFrames < frames.length ? `Preparing ${preparedFrames}/${frames.length}` : playing ? `${playbackFps} FPS` : "Ready"}</span><span>Newest</span></div></div>
              <div className="timeline-actions">
                <label className="speed-select"><span>Speed</span><select aria-label="Animation speed in frames per second" value={playbackFps} onChange={(event) => setPlaybackFps(Number(event.target.value))}><option value={2}>2 FPS</option><option value={5}>5 FPS</option><option value={10}>10 FPS</option><option value={15}>15 FPS</option></select></label>
                <Button variant="ghost" size="icon-sm" className="viewer-button" aria-label="Jump to newest frame" onClick={() => { setPlaying(false); goToFrame(Math.max(0, frames.length - 1)); }}><Radio /></Button>
                {frames.length > 0 && (
                  <Button
                    variant="ghost"
                    size={exportingGif ? "sm" : "icon-sm"}
                    className={`viewer-button transition-all ${exportingGif ? "px-2.5 font-mono text-[11px] font-semibold text-blue-600 bg-blue-50 border border-blue-200" : ""}`}
                    aria-label={exportingGif ? `Generating GIF: ${gifProgress}%` : "Download image sequence as animated GIF"}
                    title={exportingGif ? `${gifStatus} (${gifProgress}%)` : "Download sequence as animated GIF"}
                    disabled={exportingGif}
                    onClick={handleDownloadGif}
                  >
                    {exportingGif ? (
                      <span className="flex items-center gap-1.5">
                        <LoaderCircle className="size-3.5 animate-spin text-blue-600" />
                        <span>{gifProgress}%</span>
                      </span>
                    ) : (
                      <Download />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </>}
        </section>

        <aside className="border-t border-slate-200 bg-white p-4 sm:p-5 xl:border-l xl:border-t-0">
          <div className="flex items-center justify-between"><div><p className="eyebrow">Space weather now</p><h2 className="mt-1 text-base font-semibold">Live conditions</h2></div>{telemetryLoading && <LoaderCircle className="size-4 animate-spin text-slate-600" />}</div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <MetricCard label="X-ray" value={flareClass(latestXray)} detail={latestXray ? `${latestXray.toExponential(1)} W/m²` : "waiting"} tone="amber" />
            <MetricCard label="Kp index" value={latestKp?.toFixed(1) ?? "—"} detail={latestKp && latestKp >= 5 ? "storm level" : "quiet / unsettled"} tone={latestKp && latestKp >= 5 ? "rose" : "cyan"} />
            <MetricCard label="Solar wind" value={latestWind ? Math.round(latestWind).toString() : "—"} detail="km/s · SOLAR-1" tone="cyan" />
            <MetricCard label="Bz GSM" value={latestBz != null ? latestBz.toFixed(1) : "—"} detail="nT · southward drives storms" tone={latestBz != null && latestBz < -5 ? "rose" : "violet"} />
          </div>
          <div className="mt-6 flex items-center justify-between"><p className="eyebrow">Recent messages</p><a href="https://www.swpc.noaa.gov/products/alerts-watches-and-warnings" target="_blank" rel="noreferrer" className="text-[11px] text-cyan-300 hover:underline">All alerts</a></div>
          <div className="mt-2 divide-y divide-slate-200 border-y border-slate-200">
            {alerts.length ? alerts.slice(0, 4).map((alert, index) => {
              const headline = alert.message.split("\n").map((line) => line.trim()).find((line) => /ALERT|WATCH|WARNING|SUMMARY/i.test(line)) ?? alert.message.split("\n")[0];
              return <article key={`${alert.product_id}-${index}`} className="py-3.5"><div className="flex items-start gap-3"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" /><div className="min-w-0"><p className="line-clamp-2 text-xs font-medium leading-relaxed text-slate-700">{headline.replace(/^(CONTINUED )?/, "")}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{alert.product_id} · {new Date(`${alert.issue_datetime}Z`).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p></div></div></article>;
            }) : <p className="py-5 text-xs text-slate-500">No alert feed available.</p>}
          </div>
          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3.5"><div className="flex items-center gap-2 text-xs font-medium text-slate-700"><Gauge className="size-3.5 text-violet-600" /> GOES proton flux</div><div className="mt-2 flex items-end justify-between"><span className="text-2xl font-semibold tracking-tight">{latestProton?.toFixed(2) ?? "—"}</span><span className="pb-1 text-[10px] text-slate-500">pfu · ≥10 MeV</span></div></div>
          <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noreferrer" className="mt-4 flex items-center justify-between rounded-lg px-1 py-2 text-xs text-slate-500 transition hover:text-slate-900">NOAA Space Weather Prediction Center <ExternalLink className="size-3" /></a>
        </aside>
      </div>
    </main>
  );
}

function LayerList({ items, value, onChange }: { items: readonly (readonly [string, string, string])[]; value: string; onChange: (value: string) => void }) {
  return <div><label className="control-label">Layer</label><div className="space-y-1">{items.map(([key, label, detail]) => <button key={key} onClick={() => onChange(key)} className={`layer-row ${value === key ? "active" : ""}`}><span className="layer-dot" /><span className="min-w-0 text-left"><strong>{label}</strong><small>{detail}</small></span></button>)}</div></div>;
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "amber" | "cyan" | "rose" | "violet" }) {
  return <div className={`metric-card ${tone}`}><p>{label}</p><strong>{value}</strong><small>{detail}</small></div>;
}

function TelemetryPanel({ mode, xray, protons, wind, kp, loading }: { mode: TelemetryMode; xray: Point[]; protons: Point[]; wind: Point[]; kp: Point[]; loading: boolean }) {
  const config = {
    xray: { title: "GOES X-ray flux", subtitle: "0.1–0.8 nm · past 6 hours", color: "#fbbf24", data: xray, unit: "W/m²" },
    proton: { title: "GOES integral proton flux", subtitle: "≥10 MeV · past 6 hours", color: "#fb7185", data: protons, unit: "pfu" },
    wind: { title: "Real-time solar wind", subtitle: "SOLAR-1 plasma + magnetic field · past 6 hours", color: "#0b5cab", data: wind, unit: "km/s" },
    kp: { title: "Planetary Kp estimate", subtitle: "Geomagnetic activity · past 6 hours", color: "#6651a8", data: kp, unit: "Kp" },
  }[mode];
  const latest = config.data.at(-1)?.value;
  return <div className="flex min-h-[calc(100vh-7rem)] flex-col rounded-xl border border-slate-200 bg-white shadow-[0_4px_18px_rgba(35,55,75,.06)]">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5 sm:p-6"><div><p className="eyebrow">Live telemetry</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{config.title}</h2><p className="mt-1 text-xs text-slate-500">{config.subtitle}</p></div><div className="text-right"><p className="font-mono text-3xl font-semibold" style={{ color: config.color }}>{latest != null ? (mode === "xray" ? flareClass(latest) : latest.toFixed(mode === "kp" ? 1 : 2)) : "—"}</p><p className="text-[10px] uppercase tracking-widest text-slate-500">latest · {config.unit}</p></div></div>
    <div className="relative min-h-[420px] flex-1 p-3 sm:p-6">
      {loading && <div className="loading-state"><LoaderCircle className="size-5 animate-spin" /><span>Loading telemetry</span></div>}
      {!loading && config.data.length === 0 && <div className="loading-state"><CircleAlert className="size-5" /><span>No current data</span></div>}
      {!loading && config.data.length > 0 && <ResponsiveContainer width="100%" height="100%" minHeight={420}>
        {mode === "kp" ? <BarChart data={config.data} margin={{ top: 18, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e5eaf0" vertical={false} /><XAxis dataKey="time" tickFormatter={shortTime} stroke="#7b8997" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={42} /><YAxis domain={[0, 9]} stroke="#7b8997" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={30} /><Tooltip content={<ChartTooltip unit={config.unit} />} /><ReferenceLine y={5} stroke="#d64b5f" strokeDasharray="5 5" label={{ value: "G1", fill: "#b4233b", fontSize: 10 }} /><Bar dataKey="value" fill={config.color} radius={[3, 3, 0, 0]} />
        </BarChart> : mode === "wind" ? <LineChart data={config.data} margin={{ top: 18, right: 18, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e5eaf0" vertical={false} /><XAxis dataKey="time" tickFormatter={shortTime} stroke="#7b8997" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={42} /><YAxis yAxisId="speed" stroke="#7b8997" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={42} /><YAxis yAxisId="bz" orientation="right" stroke="#7b8997" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={34} /><Tooltip content={<ChartTooltip unit="km/s" secondUnit="nT Bz" />} /><ReferenceLine yAxisId="bz" y={0} stroke="#aeb9c3" /><Line yAxisId="speed" type="monotone" dataKey="value" stroke="#0b5cab" strokeWidth={2} dot={false} isAnimationActive={false} /><Line yAxisId="bz" type="monotone" dataKey="value2" stroke="#6651a8" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
        </LineChart> : <AreaChart data={config.data} margin={{ top: 18, right: 16, left: 4, bottom: 0 }}>
          <defs><linearGradient id={`fill-${mode}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={config.color} stopOpacity={0.28} /><stop offset="100%" stopColor={config.color} stopOpacity={0.01} /></linearGradient></defs><CartesianGrid stroke="#e5eaf0" vertical={false} /><XAxis dataKey="time" tickFormatter={shortTime} stroke="#7b8997" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={42} /><YAxis scale="log" domain={["auto", "auto"]} allowDataOverflow stroke="#7b8997" tick={{ fontSize: 11 }} tickFormatter={(value) => Number(value).toExponential(0)} tickLine={false} axisLine={false} width={56} /><Tooltip content={<ChartTooltip unit={config.unit} scientific />} />{mode === "xray" && <><ReferenceLine y={1e-6} stroke="#94a3b8" strokeDasharray="4 6" /><ReferenceLine y={1e-5} stroke="#d48a16" strokeDasharray="4 6" /><ReferenceLine y={1e-4} stroke="#c2414c" strokeDasharray="4 6" /></>}<Area type="monotone" dataKey="value" stroke={config.color} fill={`url(#fill-${mode})`} strokeWidth={2} dot={false} isAnimationActive={false} />
        </AreaChart>}
      </ResponsiveContainer>}
    </div>
    <div className="grid gap-3 border-t border-slate-200 p-4 text-xs text-slate-500 sm:grid-cols-3 sm:p-5"><div><span className="block text-[10px] uppercase tracking-widest text-slate-400">Source</span><strong className="mt-1 block font-medium text-slate-700">{mode === "wind" ? "NOAA SOLAR-1" : mode === "kp" ? "NOAA ground network" : "NOAA GOES primary"}</strong></div><div><span className="block text-[10px] uppercase tracking-widest text-slate-400">Samples shown</span><strong className="mt-1 block font-medium text-slate-700">{config.data.length.toLocaleString()}</strong></div><div><span className="block text-[10px] uppercase tracking-widest text-slate-400">Cadence</span><strong className="mt-1 block font-medium text-slate-700">1 minute · auto-refresh</strong></div></div>
  </div>;
}

function ChartTooltip({ active, payload, label, unit, secondUnit, scientific }: { active?: boolean; payload?: Array<{ value?: number; color?: string }>; label?: number; unit: string; secondUnit?: string; scientific?: boolean }) {
  if (!active || !payload?.length || label == null) return null;
  return <div className="rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur-md"><p className="mb-1.5 font-mono text-[10px] text-slate-500">{new Date(label).toLocaleString()}</p>{payload.map((entry, index) => entry.value != null && <p key={index} className="text-xs font-medium" style={{ color: entry.color }}>{scientific ? entry.value.toExponential(3) : entry.value.toFixed(2)} {index === 1 && secondUnit ? secondUnit : unit}</p>)}</div>;
}
