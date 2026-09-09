"use client";

// 配信スタジオ画面のブラウザ配線（requirements.md 6章・7章・8章・9章・12.1節）。
//
// lib/ 配下の各モジュール（MediaClock・SourceManager・VideoCompositor・
// AudioMixer・EncoderPipeline・SendQueue・BitrateGovernor・TransportChannel・
// TabLockGuard・BroadcastApiClient・BroadcastController）はいずれもブラウザAPIを
// 注入可能な形にしてユニットテスト済みである。このフックはその「配線の実体」
// （navigator.mediaDevices・WebCodecs・WebSocket・BroadcastChannel・Canvas等の
// 実ブラウザAPIをlib/へ注入する合成ルート）であり、ブラウザ環境に強く依存する
// ためユニットテスト対象からは除外している（jsdomではgetDisplayMedia等を
// 意味のある形でモックできないため。要件どおりモック境界をlib/側に置いた）。
//
// 実ブラウザでの動作確認はissue #4（3層結合）で行う。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BroadcastApiClient,
  type AudienceInfo,
  type BroadcastEventRecord,
} from "@/lib/broadcastApiClient";
import { BroadcastController } from "@/lib/broadcastController";
import { BitrateGovernor } from "@/lib/bitrateGovernor";
import {
  AudioEncoderPipeline,
  VideoEncoderPipeline,
  type AudioEncoderCtor,
  type VideoEncoderCtor,
} from "@/lib/encoderPipeline";
import { encodeFrame, type MediaFrame } from "@/lib/frameProtocol";
import { AudioMixer, mixBuffers } from "@/lib/audioMixer";
import { MediaClock } from "@/lib/mediaClock";
import { SendQueue } from "@/lib/sendQueue";
import { SourceManager, type SourceProviders, type TrackLike } from "@/lib/sourceManager";
import { TabLockGuard } from "@/lib/tabLockGuard";
import { TransportChannel } from "@/lib/transportChannel";
import { VideoCompositor } from "@/lib/videoCompositor";
import {
  DEFAULT_ENCODE_PROFILE,
  type BroadcastEvent,
  type BroadcastState,
  type SourceKind,
  type SourceState,
} from "@/lib/types";

const RELAY_WS_URL = (process.env.NEXT_PUBLIC_RELAY_URL ?? "http://localhost:3002").replace(
  /^http/,
  "ws",
);

const AUDIO_SILENCE_BLOCK_SAMPLES = 1024;
const AUDIO_SILENCE_INTERVAL_MS = Math.round(
  (AUDIO_SILENCE_BLOCK_SAMPLES / DEFAULT_ENCODE_PROFILE.sampleRate) * 1000,
);

export interface HealthMetrics {
  sentBitrateKbps: number;
  targetBitrateKbps: number;
  queueDelayMs: number;
  droppedFrames: number;
  connected: boolean;
}

export interface SourceStatus {
  kind: SourceKind;
  state: SourceState | "idle";
}

function detectCapabilities(): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (typeof window === "undefined") {
    return { ok: false, reasons: ["サーバー環境です"] };
  }
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    reasons.push("このブラウザはWebCodecs（ブラウザ内エンコード）に対応していません");
  }
  if (typeof WebSocket === "undefined") {
    reasons.push("このブラウザはWebSocketに対応していません");
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    reasons.push("このブラウザは画面共有APIに対応していません");
  }
  return { ok: reasons.length === 0, reasons };
}

function trackToTrackLike(track: MediaStreamTrack): TrackLike {
  return {
    addEventListener: (type, listener) => track.addEventListener(type, listener),
    removeEventListener: (type, listener) => track.removeEventListener(type, listener),
    stop: () => track.stop(),
  };
}

/** テストカードの背景色を経過時間で緩やかに変化させ、静止画ではないことを示す。 */
function testCardHue(mediaTimeUs: number): number {
  return Math.floor((mediaTimeUs / 1_000_000) * 6) % 360;
}

export function useBroadcastStudio() {
  // ブラウザ機能検出結果はマウント後に変化しないため、refではなくuseStateの
  // 遅延初期化で保持する（refの.currentをレンダー中に読むとreact-hooks/refsの
  // 対象になるため）。
  const [capabilities] = useState(() => detectCapabilities());
  const [broadcastState, setBroadcastState] = useState<BroadcastState>("idle");
  const [sources, setSources] = useState<Record<SourceKind, SourceStatus["state"]>>({
    screen: "idle",
    camera: "idle",
    mic: "idle",
    tab_audio: "idle",
    test: "active",
  });
  const [health, setHealth] = useState<HealthMetrics>({
    sentBitrateKbps: 0,
    targetBitrateKbps: DEFAULT_ENCODE_PROFILE.videoBitrateInitialKbps,
    queueDelayMs: 0,
    droppedFrames: 0,
    connected: false,
  });
  const [events, setEvents] = useState<BroadcastEvent[]>([]);
  const [broadcastId, setBroadcastId] = useState<string | null>(null);
  const [broadcastToken, setBroadcastToken] = useState<string | null>(null);
  const [audience, setAudience] = useState<AudienceInfo>({ viewerCount: 0, messages: [] });
  const [serverEvents, setServerEvents] = useState<BroadcastEventRecord[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoElementsRef = useRef<Partial<Record<SourceKind, HTMLVideoElement>>>({});
  const workerRef = useRef<Worker | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioNodesRef = useRef<
    Partial<Record<"mic" | "tab_audio", { source: MediaStreamAudioSourceNode; gain: GainNode }>>
  >({});
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveAudioSourceCountRef = useRef(0);

  const sourceManagerRef = useRef<SourceManager | null>(null);
  const compositorRef = useRef<VideoCompositor | null>(null);
  const audioMixerRef = useRef<AudioMixer | null>(null);
  const mediaClockRef = useRef<MediaClock | null>(null);
  const sendQueueRef = useRef<SendQueue | null>(null);
  const governorRef = useRef<BitrateGovernor | null>(null);
  const transportRef = useRef<TransportChannel | null>(null);
  const tabLockRef = useRef<TabLockGuard | null>(null);
  const apiClientRef = useRef<BroadcastApiClient | null>(null);
  const controllerRef = useRef<BroadcastController | null>(null);
  const videoEncoderRef = useRef<VideoEncoderPipeline | null>(null);
  const audioEncoderRef = useRef<AudioEncoderPipeline | null>(null);
  const sessionKeyRef = useRef<string>("");
  const audiencePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushEvent = useCallback((event: BroadcastEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, 200));
  }, []);

  const sendMediaFrame = useCallback((frame: MediaFrame) => {
    const queue = sendQueueRef.current;
    const transport = transportRef.current;
    if (!queue || !transport) {
      return;
    }
    const sent = transport.isConnected && transport.sendChunk(frame);
    if (!sent) {
      queue.enqueue({
        type: frame.type === "audio" ? "audio" : frame.type === "control" ? "control" : "video",
        keyframe: frame.keyframe,
        timestampUs: frame.timestampUs,
        enqueuedAtMs: Date.now(),
        payload: encodeFrame(frame),
      });
    }
  }, []);

  const drawFrame = useCallback(() => {
    const compositor = compositorRef.current;
    const sourceManager = sourceManagerRef.current;
    const mediaClock = mediaClockRef.current;
    const canvas = canvasRef.current;
    const videoEncoder = videoEncoderRef.current;
    if (!compositor || !sourceManager || !mediaClock || !canvas || !videoEncoder) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const primaryHandle = sourceManager.resolvePrimary();
    const wipeHandle = sourceManager.resolveWipe();
    const gap = mediaClock.detectGap();
    if (gap) {
      mediaClock.fillGap(gap);
      videoEncoder.forceKeyframe();
      pushEvent({ occurredAt: Date.now(), type: "gap_filled", detail: `${gap.durationMs}ms` });
    }

    if (primaryHandle.kind === "test") {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, compositor.width, compositor.height);
      const hue = testCardHue(mediaClock.videoFrameIndex);
      ctx.fillStyle = `hsl(${hue}, 60%, 20%)`;
      ctx.fillRect(0, 0, compositor.width, compositor.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "32px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("テストカード", compositor.width / 2, compositor.height / 2);
    } else {
      const primaryEl = videoElementsRef.current[primaryHandle.kind];
      const wipeEl = wipeHandle ? videoElementsRef.current[wipeHandle.kind] : undefined;
      compositor.composeFrame(ctx as unknown as never, {
        primary: primaryEl
          ? { width: primaryEl.videoWidth || 1, height: primaryEl.videoHeight || 1, image: primaryEl }
          : null,
        wipe:
          wipeEl && wipeHandle
            ? { width: wipeEl.videoWidth || 1, height: wipeEl.videoHeight || 1, image: wipeEl }
            : null,
        placeholderReason: "映像を取得できません",
      });
    }

    const timestampUs = mediaClock.nextVideoTime();
    const frame = new VideoFrame(canvas, { timestamp: timestampUs });
    try {
      videoEncoder.encode(frame);
    } finally {
      frame.close();
    }
  }, [pushEvent]);

  const emitAudioBlock = useCallback((data: Float32Array) => {
    const mediaClock = mediaClockRef.current;
    const audioEncoder = audioEncoderRef.current;
    if (!mediaClock || !audioEncoder) {
      return;
    }
    const timestampUs = mediaClock.nextAudioTime(data.length);
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: DEFAULT_ENCODE_PROFILE.sampleRate,
      numberOfFrames: data.length,
      numberOfChannels: 1,
      timestamp: timestampUs,
      // Float32Arrayのbuffer型はArrayBufferLike（SharedArrayBufferを許容）だが、
      // AudioDataInitのdataはArrayBuffer限定のBufferSourceを要求する。ここで渡す
      // データはmixBuffers/AudioMixerが生成する通常のArrayBuffer由来であるため安全。
      data: data as unknown as BufferSource,
    });
    try {
      audioEncoder.encode(audioData);
    } finally {
      audioData.close();
    }
  }, []);

  const startSilenceFallback = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      return;
    }
    silenceTimerRef.current = setInterval(() => {
      if (liveAudioSourceCountRef.current === 0) {
        const mixer = audioMixerRef.current;
        if (mixer) {
          emitAudioBlock(mixer.emitSilence());
        }
      }
    }, AUDIO_SILENCE_INTERVAL_MS);
  }, [emitAudioBlock]);

  const stopSilenceFallback = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const start = useCallback(
    async (input: { title?: string; layoutPreset: string; hpField?: string }) => {
      if (!capabilities.ok) {
        return;
      }
      const controller = controllerRef.current;
      if (!controller) {
        return;
      }

      const VideoEncoderCtorRef = VideoEncoder as unknown as VideoEncoderCtor;
      const AudioEncoderCtorRef = AudioEncoder as unknown as AudioEncoderCtor;

      videoEncoderRef.current = new VideoEncoderPipeline({
        profile: DEFAULT_ENCODE_PROFILE,
        VideoEncoderCtor: VideoEncoderCtorRef,
        onChunk: (chunk) => {
          sendMediaFrame({
            type: chunk.type === "key" ? "video" : "video",
            keyframe: chunk.type === "key",
            timestampUs: chunk.timestampUs,
            body: chunk.data,
          });
          setHealth((prev) => ({ ...prev, sentBitrateKbps: governorRef.current?.target ?? prev.sentBitrateKbps }));
        },
        onError: (err) => pushEvent({ occurredAt: Date.now(), type: "broadcast_failed", detail: err.message }),
      });

      audioEncoderRef.current = new AudioEncoderPipeline({
        profile: DEFAULT_ENCODE_PROFILE,
        AudioEncoderCtor: AudioEncoderCtorRef,
        onChunk: (chunk) => {
          sendMediaFrame({
            type: "audio",
            keyframe: chunk.type === "key",
            timestampUs: chunk.timestampUs,
            body: chunk.data,
          });
        },
      });

      await controller.start({
        title: input.title,
        layoutPreset: input.layoutPreset,
        hpField: input.hpField,
        profile: DEFAULT_ENCODE_PROFILE,
      });

      const id = controller.broadcastId;
      const token = controller.broadcastToken;
      setBroadcastId(id);
      setBroadcastToken(token);

      if (controller.state === "connecting" && id) {
        workerRef.current?.postMessage({ type: "start", intervalMs: 1000 / DEFAULT_ENCODE_PROFILE.fps });
        startSilenceFallback();
        audiencePollRef.current = setInterval(async () => {
          try {
            const info = await apiClientRef.current!.getAudience(id);
            setAudience(info);
          } catch {
            // 擬似視聴情報の取得失敗はUX上無視する（デモ版）
          }
          try {
            const records = await apiClientRef.current!.getEvents(id);
            setServerEvents(records);
          } catch {
            // サーバー側イベント履歴の取得失敗はUX上無視する（デモ版。
            // ローカルのeventsで代替表示できる）
          }
        }, 5000);
      }
    },
    [pushEvent, sendMediaFrame, startSilenceFallback, capabilities],
  );

  const stop = useCallback(async (reason?: string) => {
    const controller = controllerRef.current;
    workerRef.current?.postMessage({ type: "stop" });
    stopSilenceFallback();
    if (audiencePollRef.current !== null) {
      clearInterval(audiencePollRef.current);
      audiencePollRef.current = null;
    }
    await controller?.stop(reason);
  }, [stopSilenceFallback]);

  const attachSource = useCallback(async (kind: SourceKind) => {
    const sourceManager = sourceManagerRef.current;
    if (!sourceManager) {
      return;
    }
    try {
      // 実際の映像要素・Web Audioノードの配線はSourceProviders（acquireScreen等、
      // useEffect内で定義）が実トラック取得時に行う。ここではSourceManagerへの
      // 要求のみを行う。
      await sourceManager.attach(kind);
    } catch {
      // 拒否時はSourceManager側でdenied状態として記録済み
    }
  }, []);

  const disconnectAudioSource = useCallback((kind: "mic" | "tab_audio") => {
    const nodes = audioNodesRef.current[kind];
    if (!nodes) {
      return;
    }
    nodes.source.disconnect();
    nodes.gain.disconnect();
    delete audioNodesRef.current[kind];
    liveAudioSourceCountRef.current = Math.max(0, liveAudioSourceCountRef.current - 1);
  }, []);

  const detachSource = useCallback(
    (kind: SourceKind) => {
      sourceManagerRef.current?.detach(kind);
      delete videoElementsRef.current[kind];
      if (kind === "mic" || kind === "tab_audio") {
        disconnectAudioSource(kind);
      }
    },
    [disconnectAudioSource],
  );

  const postChat = useCallback(
    async (body: string) => {
      if (!broadcastId || !apiClientRef.current) {
        return;
      }
      const message = await apiClientRef.current.postChat(broadcastId, body);
      setAudience((prev) => ({ ...prev, messages: [...prev.messages, message] }));
    },
    [broadcastId],
  );

  useEffect(() => {
    // 実際のセッションキーはbackendが配信作成時のレスポンスで発行する
    // （中継サーバーは自身ではCookieを読まないため）。ここでは配信開始前の
    // 初期値としてのみ空文字を渡し、BroadcastController.start()が
    // createBroadcast()のレスポンスで上書きする。
    apiClientRef.current = new BroadcastApiClient();
    sendQueueRef.current = new SendQueue();
    governorRef.current = new BitrateGovernor({
      initialKbps: DEFAULT_ENCODE_PROFILE.videoBitrateInitialKbps,
      minKbps: DEFAULT_ENCODE_PROFILE.videoBitrateMinKbps,
      maxKbps: DEFAULT_ENCODE_PROFILE.videoBitrateMaxKbps,
    });
    compositorRef.current = new VideoCompositor({
      width: DEFAULT_ENCODE_PROFILE.width,
      height: DEFAULT_ENCODE_PROFILE.height,
    });
    audioMixerRef.current = new AudioMixer({ blockLength: AUDIO_SILENCE_BLOCK_SAMPLES });
    mediaClockRef.current = new MediaClock({
      fps: DEFAULT_ENCODE_PROFILE.fps,
      sampleRate: DEFAULT_ENCODE_PROFILE.sampleRate,
    });

    const providers: SourceProviders = {
      acquireScreen: async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];
        if (videoTrack) {
          bindStreamToVideoElement("screen", videoTrack, audioTrack);
        }
        return {
          video: videoTrack ? trackToTrackLike(videoTrack) : null,
          audio: audioTrack ? trackToTrackLike(audioTrack) : null,
        };
      },
      acquireCamera: async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        bindStreamToVideoElement("camera", track);
        return trackToTrackLike(track);
      },
      acquireMic: async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];
        bindAudioTrack("mic", track);
        return trackToTrackLike(track);
      },
    };

    function bindStreamToVideoElement(kind: SourceKind, videoTrack?: MediaStreamTrack, audioTrack?: MediaStreamTrack) {
      if (!videoTrack) {
        return;
      }
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.srcObject = new MediaStream([videoTrack]);
      void el.play().catch(() => undefined);
      videoElementsRef.current[kind] = el;
      if (audioTrack) {
        bindAudioTrack("tab_audio", audioTrack);
      }
    }

    function bindAudioTrack(kind: "mic" | "tab_audio", track: MediaStreamTrack) {
      const ctx = ensureAudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const gain = ctx.createGain();
      gain.gain.value = kind === "mic" ? 1.0 : 0.35;
      source.connect(gain);
      gain.connect(ensureAudioProcessor(ctx));
      audioNodesRef.current[kind] = { source, gain };
    }

    function ensureAudioContext(): AudioContext {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: DEFAULT_ENCODE_PROFILE.sampleRate });
      }
      return audioContextRef.current;
    }

    function ensureAudioProcessor(ctx: AudioContext): ScriptProcessorNode {
      if (!audioProcessorRef.current) {
        // ScriptProcessorNodeは非推奨だが、デモ版の時間制約下でAudioWorkletModuleの
        // 別配信を避けるための簡略化として採用する（issue #4で改善候補として明記）。
        const processor = ctx.createScriptProcessor(AUDIO_SILENCE_BLOCK_SAMPLES, 2, 1);
        processor.onaudioprocess = (event) => {
          const channelData = event.inputBuffer.getChannelData(0);
          const limited = mixBuffers([{ data: channelData, gain: 1 }], channelData.length);
          emitAudioBlock(limited);
        };
        const silentSink = ctx.createGain();
        silentSink.gain.value = 0;
        processor.connect(silentSink);
        silentSink.connect(ctx.destination);
        audioProcessorRef.current = processor;
      }
      return audioProcessorRef.current;
    }

    const manager = new SourceManager(providers, (event) => {
      setSources((prev) => ({ ...prev, [event.kind]: event.state }));
      pushEvent({
        occurredAt: Date.now(),
        type:
          event.state === "active"
            ? "source_attached"
            : event.state === "lost"
              ? "source_lost"
              : event.state === "substituted"
                ? "source_substituted"
                : event.state === "detached"
                  ? "source_detached"
                  : "source_lost",
        detail: event.kind,
      });
    });
    sourceManagerRef.current = manager;

    tabLockRef.current = new TabLockGuard();

    const transport = new TransportChannel({
      url: `${RELAY_WS_URL}/ws/publish`,
      WebSocketCtor: WebSocket as unknown as new (url: string) => never,
      onControl: (message) => controllerRef.current?.handleControl(message),
      onOpen: (isReconnect) => controllerRef.current?.handleTransportOpen(isReconnect),
      onClose: () => controllerRef.current?.handleTransportClose(),
      onReconnectFailed: () => controllerRef.current?.handleReconnectFailed(),
    });
    transportRef.current = transport;

    const controller = new BroadcastController({
      sessionKey: sessionKeyRef.current,
      apiClient: apiClientRef.current,
      tabLockGuard: tabLockRef.current,
      transport,
      sendQueue: sendQueueRef.current,
      governor: governorRef.current,
      onStateChange: setBroadcastState,
      onEvent: pushEvent,
      onForceKeyframe: () => videoEncoderRef.current?.forceKeyframe(),
      onResendConfig: () => {
        const videoConfig = videoEncoderRef.current?.configChunk();
        const audioConfig = audioEncoderRef.current?.configChunk();
        if (videoConfig) {
          sendMediaFrame({ type: "video_config", keyframe: true, timestampUs: videoConfig.timestampUs, body: videoConfig.data });
        }
        if (audioConfig) {
          sendMediaFrame({ type: "audio_config", keyframe: true, timestampUs: audioConfig.timestampUs, body: audioConfig.data });
        }
      },
      onBitrateChange: (kbps) => setHealth((prev) => ({ ...prev, targetBitrateKbps: kbps })),
    });
    controllerRef.current = controller;

    const worker = new Worker(new URL("../../workers/compositionClockWorker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "tick") {
        drawFrame();
      }
    };
    workerRef.current = worker;

    const healthTimer = setInterval(() => {
      const queue = sendQueueRef.current;
      if (!queue || !transportRef.current) {
        return;
      }
      setHealth((prev) => ({
        ...prev,
        queueDelayMs: queue.queueDelayMs(Date.now()),
        droppedFrames: queue.droppedVideoFrames,
        connected: transportRef.current!.isConnected,
      }));
    }, 1000);

    return () => {
      clearInterval(healthTimer);
      worker.terminate();
      tabLockRef.current?.close();
      audioProcessorRef.current?.disconnect();
      audioContextRef.current?.close().catch(() => undefined);
      if (audiencePollRef.current !== null) {
        clearInterval(audiencePollRef.current);
      }
      stopSilenceFallback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    capabilities,
    broadcastState,
    sources,
    health,
    events,
    broadcastId,
    broadcastToken,
    audience,
    serverEvents,
    canvasRef,
    start,
    stop,
    attachSource,
    detachSource,
    postChat,
  };
}
