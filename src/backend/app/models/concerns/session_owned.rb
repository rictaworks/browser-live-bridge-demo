# 全テーブル共通のオーナーキー制約（requirements.md 9節・21節）。
#
# session_id をオーナーキーとして持つモデルにincludeする。`for_session` を経由しない
# 素の `find` / `where` を使うと、実装ミスでセッションをまたいだ参照が発生し得るため、
# コントローラーは必ず `for_session` を通してレコードへ到達すること。
module SessionOwned
  extend ActiveSupport::Concern

  included do
    validates :session_id, presence: true

    scope :for_session, ->(session_key) { where(session_id: session_key) }
  end
end
