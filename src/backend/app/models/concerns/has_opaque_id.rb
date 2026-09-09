# 主キーが不透明な文字列（UUID）のテーブル共通の採番。
module HasOpaqueId
  extend ActiveSupport::Concern

  included do
    before_create { self.id ||= SecureRandom.uuid }
  end
end
