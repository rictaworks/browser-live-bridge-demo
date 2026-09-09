# Bot対策のハニーポット方式（requirements.md 21節、reCAPTCHA不使用）。
# フォームに隠しフィールドを仕込み、値が埋まっていれば機械的な投稿とみなす。
class HoneypotGuard
  FIELD_NAME = :hp_field

  def self.bot?(params)
    params[FIELD_NAME].present?
  end
end
