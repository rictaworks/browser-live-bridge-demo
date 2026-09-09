// 映像合成（requirements.md 6.3節）。
//
// - 出力解像度は固定。主映像は内接（アスペクト比維持）＋単色余白
// - ワイプは右下配置。幅・余白・角丸はすべて出力幅に対する比率で定義する
//   （絶対値を用いない）
// - 合成結果は毎回1枚の完成フレームとして確定する（背景全面を塗りつぶして
//   から描画するため、部分更新には依存しない）
//
// 実際の描画API呼び出し（CanvasRenderingContext2D / OffscreenCanvasの
// 2Dコンテキスト）はCanvasLikeとして抽象化し、ユニットテストではモックに
// 差し替える。時間駆動の合成ループ自体はtimeDrivenScheduler.tsが担う
// （requirements.md 6.3節：requestAnimationFrame非依存・Web Worker推奨）。

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ワイプの幅（出力幅に対する比率） */
export const WIPE_WIDTH_RATIO = 0.28;
/** ワイプの余白（出力幅に対する比率） */
export const WIPE_MARGIN_RATIO = 0.03;
/** ワイプの角丸半径（出力幅に対する比率） */
export const WIPE_CORNER_RADIUS_RATIO = 0.02;
/** ワイプの縦横比（一般的なWebカメラを想定した16:9） */
export const WIPE_ASPECT_RATIO = 9 / 16;

/**
 * 主映像を出力枠に内接させる矩形を計算する（縦横比維持、中央寄せ）。
 * 余白は呼び出し側が単色で塗りつぶす。
 */
export function computeContainRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Rect {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: targetWidth, height: targetHeight };
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

/** ワイプの矩形を出力枠に対する比率から計算する（右下配置）。 */
export function computeWipeRect(
  targetWidth: number,
  targetHeight: number,
  widthRatio: number = WIPE_WIDTH_RATIO,
  marginRatio: number = WIPE_MARGIN_RATIO,
  aspectRatio: number = WIPE_ASPECT_RATIO,
): Rect {
  const width = targetWidth * widthRatio;
  const height = width * aspectRatio;
  const margin = targetWidth * marginRatio;
  return {
    x: targetWidth - width - margin,
    y: targetHeight - height - margin,
    width,
    height,
  };
}

/** ワイプの角丸半径を出力幅に対する比率から計算する。 */
export function computeWipeCornerRadius(
  targetWidth: number,
  radiusRatio: number = WIPE_CORNER_RADIUS_RATIO,
): number {
  return targetWidth * radiusRatio;
}

export interface DrawableSource {
  width: number;
  height: number;
  /** CanvasImageSource互換の描画元（VideoFrame/HTMLVideoElement等）。この層では不透明に扱う。 */
  image: unknown;
}

/**
 * この層が利用する2D描画コンテキストの最小インターフェース。
 * 実体はCanvasRenderingContext2D／OffscreenCanvasRenderingContext2D。
 */
export interface CanvasLike {
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  roundRect(x: number, y: number, w: number, h: number, radius: number): void;
  clip(): void;
}

export interface ComposeInput {
  primary: DrawableSource | null;
  wipe: DrawableSource | null;
  /** primaryがnullのときに表示する理由（例: "画面共有が停止しました"） */
  placeholderReason?: string;
}

export interface VideoCompositorOptions {
  width: number;
  height: number;
  /** 主映像の余白色（既定: 黒） */
  backgroundColor?: string;
  /** テストカード等プレースホルダーの背景色 */
  placeholderColor?: string;
  wipeWidthRatio?: number;
  wipeMarginRatio?: number;
  wipeCornerRadiusRatio?: number;
}

export class VideoCompositor {
  readonly width: number;
  readonly height: number;
  private readonly backgroundColor: string;
  private readonly placeholderColor: string;
  private readonly wipeWidthRatio: number;
  private readonly wipeMarginRatio: number;
  private readonly wipeCornerRadiusRatio: number;

  constructor(options: VideoCompositorOptions) {
    this.width = options.width;
    this.height = options.height;
    this.backgroundColor = options.backgroundColor ?? "#000000";
    this.placeholderColor = options.placeholderColor ?? "#1a1a2e";
    this.wipeWidthRatio = options.wipeWidthRatio ?? WIPE_WIDTH_RATIO;
    this.wipeMarginRatio = options.wipeMarginRatio ?? WIPE_MARGIN_RATIO;
    this.wipeCornerRadiusRatio = options.wipeCornerRadiusRatio ?? WIPE_CORNER_RADIUS_RATIO;
  }

  /**
   * 1フレーム分の完成した合成結果を描画する。部分更新は行わず、
   * 毎回背景全面の塗りつぶしから描き直す。
   */
  composeFrame(ctx: CanvasLike, input: ComposeInput): void {
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, this.width, this.height);

    if (input.primary) {
      const rect = computeContainRect(
        input.primary.width,
        input.primary.height,
        this.width,
        this.height,
      );
      ctx.drawImage(input.primary.image, rect.x, rect.y, rect.width, rect.height);
    } else {
      this.renderPlaceholder(ctx, input.placeholderReason ?? "映像を取得できません");
    }

    if (input.wipe) {
      const rect = computeWipeRect(
        this.width,
        this.height,
        this.wipeWidthRatio,
        this.wipeMarginRatio,
      );
      const radius = computeWipeCornerRadius(this.width, this.wipeCornerRadiusRatio);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
      ctx.clip();
      ctx.drawImage(input.wipe.image, rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }
  }

  /** テストカード・ソース喪失時などの代替フレームを描画する。 */
  renderPlaceholder(ctx: CanvasLike, reason: string): void {
    ctx.fillStyle = this.placeholderColor;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.max(12, Math.round(this.height * 0.05))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(reason, this.width / 2, this.height / 2);
  }
}
