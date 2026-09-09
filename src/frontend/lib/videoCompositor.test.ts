import {
  computeContainRect,
  computeWipeCornerRadius,
  computeWipeRect,
  VideoCompositor,
  type CanvasLike,
} from "./videoCompositor";

function makeMockCtx(): jest.Mocked<CanvasLike> {
  return {
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    fillRect: jest.fn(),
    drawImage: jest.fn(),
    fillText: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    beginPath: jest.fn(),
    roundRect: jest.fn(),
    clip: jest.fn(),
  };
}

describe("computeContainRect", () => {
  it("横長ソースを16:9の出力枠へ縦横比維持で内接させる（上下に余白）", () => {
    const rect = computeContainRect(4000, 3000, 1280, 720); // 4:3を16:9枠へ
    expect(rect.width).toBeCloseTo(960);
    expect(rect.height).toBeCloseTo(720);
    expect(rect.x).toBeCloseTo((1280 - 960) / 2);
    expect(rect.y).toBeCloseTo(0);
  });

  it("出力枠と同一比率のソースは余白なしで枠いっぱいになる", () => {
    const rect = computeContainRect(1920, 1080, 1280, 720);
    expect(rect.width).toBeCloseTo(1280);
    expect(rect.height).toBeCloseTo(720);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
  });

  it("ソースサイズが不正な場合は出力枠全体を返す", () => {
    const rect = computeContainRect(0, 0, 1280, 720);
    expect(rect).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });
});

describe("computeWipeRect / computeWipeCornerRadius", () => {
  it("ワイプの幅・余白・角丸はすべて出力幅に対する比率で決まる（絶対値ではない）", () => {
    const small = computeWipeRect(640, 360);
    const large = computeWipeRect(1280, 720);

    expect(large.width).toBeCloseTo(small.width * 2);
    expect(large.height).toBeCloseTo(small.height * 2);

    const smallRadius = computeWipeCornerRadius(640);
    const largeRadius = computeWipeCornerRadius(1280);
    expect(largeRadius).toBeCloseTo(smallRadius * 2);
  });

  it("ワイプは右下に配置される", () => {
    const rect = computeWipeRect(1280, 720);
    expect(rect.x + rect.width).toBeLessThan(1280);
    expect(rect.y + rect.height).toBeLessThan(720);
    expect(rect.x).toBeGreaterThan(1280 / 2);
    expect(rect.y).toBeGreaterThan(720 / 2);
  });
});

describe("VideoCompositor", () => {
  const compositor = new VideoCompositor({ width: 1280, height: 720 });

  it("composeFrameは常に背景全面を塗りつぶしてから主映像を描画する（毎回1枚の完成フレーム）", () => {
    const ctx = makeMockCtx();
    compositor.composeFrame(ctx, {
      primary: { width: 1920, height: 1080, image: "primary-image" },
      wipe: null,
    });

    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      "primary-image",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("主映像がnullの場合はプレースホルダーを描画する", () => {
    const ctx = makeMockCtx();
    compositor.composeFrame(ctx, { primary: null, wipe: null, placeholderReason: "画面共有が停止しました" });

    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith(
      "画面共有が停止しました",
      640,
      360,
    );
  });

  it("ワイプがある場合は角丸クリップして描画する", () => {
    const ctx = makeMockCtx();
    compositor.composeFrame(ctx, {
      primary: { width: 1920, height: 1080, image: "primary-image" },
      wipe: { width: 640, height: 360, image: "wipe-image" },
    });

    expect(ctx.save).toHaveBeenCalled();
    expect(ctx.roundRect).toHaveBeenCalled();
    expect(ctx.clip).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalledWith(
      "wipe-image",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
    expect(ctx.restore).toHaveBeenCalled();
  });

  it("ワイプがない場合はroundRect/clipを呼ばない", () => {
    const ctx = makeMockCtx();
    compositor.composeFrame(ctx, {
      primary: { width: 1920, height: 1080, image: "primary-image" },
      wipe: null,
    });

    expect(ctx.roundRect).not.toHaveBeenCalled();
    expect(ctx.clip).not.toHaveBeenCalled();
  });
});
