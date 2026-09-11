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
  // Issue #35: 配信開始前でもカメラ・マイクを確認できるようにする。合成・
  // 符号化パイプライン（drawFrame・AudioEncoderPipeline等）とは独立した
  // プレビュー専用の経路とし、既存の配信ロジックには一切影響しない。
  const [cameraPreviewStream, setCameraPreviewStream] = useState<MediaStream | null>(null);
  const [micLevel, setMicLevel] = useState(0);

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
  // Issue #35: マイクの音量レベルメーター用。エンコード用の音声グラフ
  // （source -> gain -> processor）とは別に、sourceから並行してタップする。
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ライブ中盤でのvideo_config/audio_config自動再送を「最初の1回だけ」に
  // 抑えるためのフラグ。理由はonConfig配線側のコメントを参照。
  const videoConfigAutoSentRef = useRef(false);
  const audioConfigAutoSentRef = useRef(false);

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
  const appliedBitrateKbpsRef = useRef<number | null>(null);
  const audioEncoderRef = useRef<AudioEncoderPipeline | null>(null);
  const audioEncoderClosedRef = useRef<boolean>(false);
  const videoEncoderClosedRef = useRef<boolean>(false);
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
      // frame.typeは"video"/"audio"/"control"に加え"video_config"/"audio_config"も
      // 取り得る（onConfig経由）。SendQueueItem.typeは"video"|"audio"|"control"の
      // 3値のみのため、*_configはそれぞれ対応する本体種別へ分類する
      // （configは常にkeyframe:trueのためdropNonKeyVideo()の対象にはならないが、
      // 分類自体が誤っているのは直しておく）。
      queue.enqueue({
        type: frame.type === "control" ? "control" : frame.type.includes("audio") ? "audio" : "video",
        keyframe: frame.keyframe,
        timestampUs: frame.timestampUs,
        enqueuedAtMs: Date.now(),
        payload: encodeFrame(frame),
      });
    }
  }, []);

  /** 接続確立の直後（初回接続・再接続いずれも）に、送信できず
   * SendQueueへ退避されていたフレームを送り届ける。音声フレーム・
   * キーフレームは破棄対象外（requirements.md 7節）のため、未接続中は
   * 送信を保留しているだけで、接続後にこれを送らないと「滞留時間」
   * （キュー内最古フレームの経過時間）が回復せず増え続けたまま
   * 高止まりする（実機で20万msを超えるまで増え続ける障害として確認済み）。
   * 初回接続でも、WebSocketのopen完了よりエンコーダの最初の1フレーム
   * 処理が先に終わり、video_config等がSendQueueへ積まれたまま送られない
   * ケースがあるため（実機確認済み）、isReconnectに関係なく毎回呼ぶ。
   * 何も積まれていなければdrainAll()は空配列を返すだけで無害。
   * SendQueueItem.payloadは退避時点で既にencodeFrame()済みのバイト列の
   * ため、TransportChannel.sendRaw()でそのまま送る
   * （再エンコード・組み立て直しは行わない）。
   * 呼び出しは必ずvideo_config/audio_configの再送後にすること。中継は
   * 接続のたびに新しいセッションとして扱い、設定情報を受け取るまで
   * 映像・音声フレームを無言で破棄するため（6.7節）、逆順だと退避
   * フレームがまるごと中継側で破棄される。 */
  const flushSendQueue = useCallback(() => {
    const queue = sendQueueRef.current;
    const transport = transportRef.current;
    if (!queue || !transport) {
      return;
    }
    for (const item of queue.drainAll()) {
      transport.sendRaw(item.payload);
    }
  }, []);

  const drawFrame = useCallback(() => {
    const compositor = compositorRef.current;
    const sourceManager = sourceManagerRef.current;
    const mediaClock = mediaClockRef.current;
    const canvas = canvasRef.current;
    const videoEncoder = videoEncoderRef.current;
    if (!compositor || !sourceManager || !mediaClock || !canvas || !videoEncoder || videoEncoderClosedRef.current) {
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

    // requirements.md 6.5節「キーフレーム間隔 2秒」。実時計のタイマーではなく
    // メディアクロックのフレーム番号で判定する（6.5節「時刻はメディアクロックで
    // 採番すること...実時計を用いないこと」との整合。タブの非アクティブ化・
    // 最小化時も合成ループ自体は規定fpsで継続する設計（6.3節）のため、この
    // カウンタも実時計非依存のまま正しく2秒間隔を保つ）。中継は保持期間
    // （既定8秒）より古いキーフレームを追跡できず、新規視聴者のcatchUpに
    // 一切の映像フレームが含まれないまま後続のキーフレームを永久に待ち続ける
    // 障害につながっていた（実機確認：定期発行が存在せず、配信開始直後の
    // 初回1回・再接続時・タイムギャップ補填時以外にキーフレームが一切発行
    // されていなかった）。
    const keyframeIntervalFrames = Math.round(
      DEFAULT_ENCODE_PROFILE.fps * DEFAULT_ENCODE_PROFILE.keyframeIntervalSec,
    );
    if (mediaClock.videoFrameIndex % keyframeIntervalFrames === 0) {
      videoEncoder.forceKeyframe();
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
    if (!mediaClock || !audioEncoder || audioEncoderClosedRef.current) {
      return;
    }
    const timestampUs = mediaClock.nextAudioTime(data.length);
    // AudioMixerはモノラル（1チャンネル分）のバッファしか生成しないが、
    // requirements.md 6.5節どおりエンコード出力はチャンネル数2（ステレオ）で
    // 構成する（DEFAULT_ENCODE_PROFILE.channels）。AudioEncoderの設定と
    // AudioDataの宣言チャンネル数が食い違うとencode()がエラーで閉塞するため、
    // モノラルの内容をL/R両チャンネルへ複製したplanarバッファを渡す。
    const channels = DEFAULT_ENCODE_PROFILE.channels;
    const planar = new Float32Array(data.length * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      planar.set(data, channel * data.length);
    }
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: DEFAULT_ENCODE_PROFILE.sampleRate,
      numberOfFrames: data.length,
      numberOfChannels: channels,
      timestamp: timestampUs,
      // Float32Arrayのbuffer型はArrayBufferLike（SharedArrayBufferを許容）だが、
      // AudioDataInitのdataはArrayBuffer限定のBufferSourceを要求する。ここで渡す
      // データはmixBuffers/AudioMixerが生成する通常のArrayBuffer由来であるため安全。
      data: planar as unknown as BufferSource,
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

      videoEncoderClosedRef.current = false;
      // 新しいVideoEncoderPipelineはprofile.videoBitrateInitialKbpsから始まるため、
      // 前回配信終了時点の適用済みビットレートの記憶をここでリセットする
      // （リセットしないと、たまたま今回最初のevaluate()の値と一致した場合に
      // setBitrate()がスキップされ、表示上のtargetBitrateKbpsと実際の
      // エンコーダ設定が食い違ったままになる）。
      appliedBitrateKbpsRef.current = null;
      // 前回配信の「初回config送信済み」記憶が残っていると、新しい配信の
      // 最初のconfigすら送られなくなる。
      videoConfigAutoSentRef.current = false;
      audioConfigAutoSentRef.current = false;
      // sendQueueはhookマウント時に1度だけ生成される参照のため、前回配信の
      // 残留フレーム（切断中に溜まったもの等）が同一ページセッション内の
      // 次の配信へ持ち越されないよう、配信開始のたびに明示的に空にする。
      sendQueueRef.current?.clear();
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
        // decoderConfigは初回接続時に一度だけ自動送信する。onResendConfigは
        // 再接続時の再送専用で、初回接続時点ではまだconfigChunk()が存在せず
        // 何も送れないため、これが無いと中継が映像設定を一度も受け取れない
        // （6.7節「映像設定・音声設定を受け取るまでpublishを開始しないこと」に抵触する）。
        //
        // setBitrate()による再設定でもdecoderConfigは再度届くが、これを毎回
        // 自動送信しないよう1回限りに制限している。中継(session.go)のstateLive
        // ハンドラはKindVideoConfig/KindAudioConfigを受信すると、通常の映像・
        // 音声フレームが経由するratecontrol.Queueを迂回してpublisher.WriteVideo/
        // WriteAudioへ直接書き込む実装になっており、配信中盤でconfigを送るたびに
        // キュー内の未送出フレームを追い越してローカルingestへ書き込まれ、
        // モニター側でタイムスタンプ不整合・多重初期化（"Found another
        // AVCDecoderConfigurationRecord!"等）を起こし再生が止まる障害を実機で
        // 確認した。適応制御でビットレートが変わるたびに毎回この経路を踏むため、
        // 数秒以上配信するとほぼ必ず発生する。lastConfigChunk自体は
        // encoderPipeline.ts側で常に最新へ更新され続けるため、再接続時の
        // onResendConfigは影響を受けず正しく最新のconfigを送れる。
        onConfig: (chunk) => {
          if (videoConfigAutoSentRef.current) {
            return;
          }
          videoConfigAutoSentRef.current = true;
          sendMediaFrame({ type: "video_config", keyframe: true, timestampUs: chunk.timestampUs, body: chunk.data });
        },
        onError: (err) => {
          // WebCodecsのVideoEncoderはエラー後closed状態になり、以降のencode()は
          // 例外を投げ続ける（drawFrameはcomposition workerのtickごとに毎回呼ばれる
          // ため、無捕捉のまま暴走する）。音声側(audioEncoderClosedRef)と同様に
          // 閉塞を記録して以降の呼び出しを止める。
          videoEncoderClosedRef.current = true;
          pushEvent({ occurredAt: Date.now(), type: "broadcast_failed", detail: err.message });
        },
      });

      audioEncoderClosedRef.current = false;
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
        // 映像側のonConfigと同じ理由で初回1回のみ自動送信する。
        onConfig: (chunk) => {
          if (audioConfigAutoSentRef.current) {
            return;
          }
          audioConfigAutoSentRef.current = true;
          sendMediaFrame({ type: "audio_config", keyframe: true, timestampUs: chunk.timestampUs, body: chunk.data });
        },
        onError: (err) => {
          // WebCodecsのAudioEncoderはエラー後closed状態になり、以降のencode()は
          // 例外を投げ続ける。閉塞を記録して以降の呼び出しを止める（無限リトライ防止）。
          audioEncoderClosedRef.current = true;
          pushEvent({ occurredAt: Date.now(), type: "broadcast_failed", detail: err.message });
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
    if (kind === "mic") {
      if (micLevelTimerRef.current !== null) {
        clearInterval(micLevelTimerRef.current);
        micLevelTimerRef.current = null;
      }
      micAnalyserRef.current?.disconnect();
      micAnalyserRef.current = null;
      setMicLevel(0);
    }
  }, []);

  const detachSource = useCallback(
    (kind: SourceKind) => {
      sourceManagerRef.current?.detach(kind);
      delete videoElementsRef.current[kind];
      if (kind === "camera") {
        setCameraPreviewStream(null);
      }
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
      if (kind === "camera") {
        // Issue #35: 配信開始前でもカメラ映像を確認できるようにする。
        setCameraPreviewStream(el.srcObject as MediaStream);
      }
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
      if (kind === "mic") {
        // Issue #35: 配信開始前でもマイクの音量を確認できるようにする。
        // エンコード用のグラフ（source -> gain -> processor）には手を加えず、
        // sourceから並行してAnalyserNodeへタップするだけの副経路とする。
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        micAnalyserRef.current = analyser;
        const levels = new Uint8Array(analyser.frequencyBinCount);
        micLevelTimerRef.current = setInterval(() => {
          analyser.getByteTimeDomainData(levels);
          let sumSq = 0;
          for (let i = 0; i < levels.length; i++) {
            const centered = (levels[i] - 128) / 128;
            sumSq += centered * centered;
          }
          setMicLevel(Math.sqrt(sumSq / levels.length));
        }, 100);
      }
      // disconnectAudioSource()側の減算と対になる加算がここに漏れていたため、
      // liveAudioSourceCountRefが常に0のまま（実機で確認した障害）。0のままだと
      // startSilenceFallback()の無音生成が実マイク入力と並行して動き続け、
      // 無音ブロックと実音声ブロックの両方がmediaClock.nextAudioTime()の同じ
      // タイムラインへ交互に積まれて音声が破綻する（＝音声が届かないように聞こえる）。
      liveAudioSourceCountRef.current += 1;
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
      // マイク・タブ音声がユーザー操作を介さず喪失した場合（デバイスの物理的な
      // 切断・OSレベルでの許可取り消し・ブラウザ純正の「共有を停止」操作等）は
      // SourceManagerが直接track.addEventListener("ended")で検知しここへ
      // "lost"として届く。detachSource()経由の明示的な解除と違い
      // disconnectAudioSource()を誰も呼ばないため、liveAudioSourceCountRefが
      // 減算されないまま（トラック自体は既に終了済みで実音声は流れない）に
      // なり、無音フォールバックへも切り替わらない実害があった
      // （requirements.md 8節「マイクの喪失→無音生成に切替え」に反する）。
      if (event.state === "lost" && (event.kind === "mic" || event.kind === "tab_audio")) {
        disconnectAudioSource(event.kind);
      }
      // Issue #35: カメラの喪失時もプレビューを閉じる（detachSource()経由の
      // 明示的な解除と違い、こちらもsetCameraPreviewStream(null)を誰も
      // 呼ばないため、喪失後も直前の映像が表示され続けてしまう）。
      if (event.state === "lost" && event.kind === "camera") {
        setCameraPreviewStream(null);
      }
      // "requesting"（取得試行中）・"denied"（許可拒否）はUI上のバッジ表示
      // （SOURCE_STATE_LABELS）だけで表現し、イベントログには残さない。
      // 以前はここが漏れて default 節に落ち、取得試行中の一瞬が
      // 「ソースを喪失しました」と誤表示されていた（実機で確認した障害）。
      if (event.state === "requesting" || event.state === "denied") {
        return;
      }
      pushEvent({
        occurredAt: Date.now(),
        type:
          event.state === "active"
            ? "source_attached"
            : event.state === "lost"
              ? "source_lost"
              : event.state === "substituted"
                ? "source_substituted"
                : "source_detached",
        detail: event.kind,
      });
    });
    sourceManagerRef.current = manager;

    tabLockRef.current = new TabLockGuard();

    const transport = new TransportChannel({
      url: `${RELAY_WS_URL}/ws/publish`,
      WebSocketCtor: WebSocket as unknown as new (url: string) => never,
      onControl: (message) => controllerRef.current?.handleControl(message),
      onOpen: (isReconnect) => {
        // 中継は接続のたびに新しいセッションとして扱い、video_config・
        // audio_configを受け取るまで映像・音声フレームを無言で破棄する
        // （requirements.md 6.7節）。そのためhandleTransportOpen()による
        // 設定情報の再送を必ず先に行い、その後で退避フレームを再送する。
        // 逆順にすると、再送したはずの退避フレーム（音声・キーフレーム）が
        // 中継の「設定情報待ち」状態で丸ごと破棄されてしまう
        // （実機に近い構成でのreviewer指摘により発覚・修正）。
        controllerRef.current?.handleTransportOpen(isReconnect);
        // 以前はisReconnectの時だけflushSendQueue()していたが、初回接続でも
        // WebSocketのopen完了よりエンコーダの最初の1フレーム処理が先に
        // 終わることがあり、その場合sendMediaFrame()はtransport.isConnected
        // がまだfalseのためSendQueueへ積んでしまう（video_config等の重要
        // フレームを含む）。isReconnect限定だと、以後一度も再接続しない
        // 配信ではこの退避フレームが永久にSendQueueへ残ったまま送られず、
        // 中継はvideo_config/audio_configの片方または両方を受け取れないまま
        // stateAwaitingConfigに留まり続け、映像・音声が一切publishされない
        // （reviewer指摘により発覚）。初回接続でも同様に退避分を送り届ける
        // 必要があるため、isReconnectに関わらず常に呼ぶ。何も積まれていない
        // 通常時はdrainAll()が空配列を返すだけで無害。
        flushSendQueue();
      },
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
      onBitrateChange: (kbps) => {
        // 表示の更新だけでなく、実際のエンコーダへも反映する（requirements.md 7節）。
        // これが漏れていたため、劣化検知・抑制指示はイベントログ上は機能していても
        // 実際の送出データ量が一切減らず、送出キューが際限なく膨張し続けていた
        // （実機で滞留時間が20万msを超えるまで成長する障害を確認）。
        // evaluateTick()は毎秒onBitrateChangeを呼ぶため、値が変化した時のみ
        // setBitrate()する（無変化での毎秒の再設定・config再送信を避ける）。
        if (appliedBitrateKbpsRef.current !== kbps) {
          appliedBitrateKbpsRef.current = kbps;
          videoEncoderRef.current?.setBitrate(kbps);
        }
        setHealth((prev) => ({ ...prev, targetBitrateKbps: kbps }));
      },
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
      if (micLevelTimerRef.current !== null) {
        clearInterval(micLevelTimerRef.current);
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
    cameraPreviewStream,
    micLevel,
    start,
    stop,
    attachSource,
    detachSource,
    postChat,
  };
}
