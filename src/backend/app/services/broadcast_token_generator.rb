# 配信トークン（モニターURL用）の発行（requirements.md 9節・21節）。
# セッションキーから導出しない、独立した推測不可能な識別子とする。
class BroadcastTokenGenerator
  TOKEN_BYTES = 32

  def self.generate
    SecureRandom.urlsafe_base64(TOKEN_BYTES)
  end
end
