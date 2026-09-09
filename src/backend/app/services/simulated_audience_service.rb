# 擬似視聴者数・擬似チャットの決定的生成（requirements.md 11節）。
#
# 配信トークンを種とし、経過時間だけの純粋関数として算出する。実時計・DBの状態には一切依存しないため、
# 同一配信を再度開いても常に同じ推移を再現できる（requirements.md 6.5節のメディアクロックの考え方と同様、
# 実時計に依存しないという方針をここでも踏襲する）。
class SimulatedAudienceService
  MAX_VIEWERS = 480
  BUCKET_SECONDS = 20
  MESSAGE_MIN_INTERVAL_SECONDS = 8
  MESSAGE_MAX_INTERVAL_SECONDS = 45
  AUTHOR_LABEL_PREFIX = "視聴者"

  # 擬似チャット定型文（13.2節「擬似チャット定型文 40」）。氏名・ニックネーム等の個人情報は含まない。
  TEMPLATES = [
    "こんにちは！",
    "画質がきれいですね",
    "音声もクリアに聞こえます",
    "遅延が少なくて驚きました",
    "ブラウザだけで配信できるんですね",
    "これは便利そうです",
    "画面共有わかりやすいです",
    "レイアウトいい感じですね",
    "続きが気になります",
    "応援しています",
    "初めて見ました",
    "テストカードも綺麗ですね",
    "接続が安定していますね",
    "解説ありがとうございます",
    "次も見たいです",
    "ワイプの位置がちょうどいいですね",
    "音量バランスがいいです",
    "とても分かりやすいです",
    "配信お疲れさまです",
    "画面が見やすいです",
    "楽しみにしていました",
    "この技術すごいですね",
    "スムーズに再生されています",
    "設定が簡単そうですね",
    "いい雰囲気ですね",
    "参考になります",
    "質問してもいいですか",
    "資料も見やすいです",
    "声が聞き取りやすいです",
    "動きがなめらかですね",
    "配信環境が整っていますね",
    "画面切り替えがスムーズです",
    "説明が丁寧ですね",
    "とても興味深いです",
    "後で見返したいです",
    "共有ありがとうございます",
    "素晴らしい内容ですね",
    "勉強になります",
    "また見に来ます",
    "お疲れさまでした"
  ].freeze

  def self.viewer_count(token, elapsed_seconds)
    elapsed = normalize_elapsed(elapsed_seconds)
    idx = (elapsed / BUCKET_SECONDS).floor
    frac = (elapsed % BUCKET_SECONDS) / BUCKET_SECONDS.to_f

    v0 = bucket_value(token, idx)
    v1 = bucket_value(token, idx + 1)
    value = v0 + ((v1 - v0) * frac)

    value.round.clamp(0, MAX_VIEWERS)
  end

  # 経過時間までに生成されるべき擬似チャットの一覧を返す。定型文40件から幅のある間隔で生成し、
  # 呼び出すたびに同じ内容・同じ順序を返す（同一配信を再度開いた場合の再現性）。
  def self.messages_until(token, elapsed_seconds, limit: 500)
    elapsed = normalize_elapsed(elapsed_seconds)
    result = []
    cursor = 0.0
    idx = 0

    while idx < limit
      cursor += interval_for(token, idx)
      break if cursor > elapsed

      result << {
        index: idx,
        offset_seconds: cursor.round,
        author_label: author_label_for(token, idx),
        body: template_for(token, idx)
      }
      idx += 1
    end

    result
  end

  def self.normalize_elapsed(elapsed_seconds)
    [ elapsed_seconds.to_f, 0.0 ].max
  end
  private_class_method :normalize_elapsed

  def self.bucket_value(token, idx)
    base_level(idx * BUCKET_SECONDS) + jitter(token, idx)
  end
  private_class_method :bucket_value

  # ゆるやかに増加したのち緩やかに揺らぐ基準カーブ。急峻な跳躍を持たないための土台。
  def self.base_level(elapsed_at_bucket)
    ramp = [ 3 + (elapsed_at_bucket / 15.0), 42 ].min
    wave = 4 * Math.sin(elapsed_at_bucket / 137.0)
    ramp + wave
  end
  private_class_method :base_level

  def self.jitter(token, idx)
    prng_for(token, "viewer", idx).rand(-3.0..3.0)
  end
  private_class_method :jitter

  def self.interval_for(token, idx)
    prng_for(token, "interval", idx).rand(MESSAGE_MIN_INTERVAL_SECONDS..MESSAGE_MAX_INTERVAL_SECONDS)
  end
  private_class_method :interval_for

  def self.template_for(token, idx)
    TEMPLATES[prng_for(token, "template", idx).rand(TEMPLATES.size)]
  end
  private_class_method :template_for

  def self.author_label_for(token, idx)
    # 氏名・ニックネーム・メールアドレスを用いない非個人ラベル（requirements.md 11節・21節）。
    suffix = Digest::MD5.hexdigest("#{token}:author:#{idx}")[0, 4].upcase
    "#{AUTHOR_LABEL_PREFIX}-#{suffix}"
  end
  private_class_method :author_label_for

  # 種別・indexごとに独立した決定的な乱数列を作る。同じtoken・種別・indexなら常に同じ結果になる。
  def self.prng_for(token, kind, idx)
    seed = Digest::SHA256.hexdigest("#{token}:#{kind}:#{idx}").to_i(16) % (2**31 - 1)
    Random.new(seed)
  end
  private_class_method :prng_for
end
