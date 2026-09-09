# 擬似チャットおよび配信者の投稿（requirements.md 11節）。
class ChatMessage < ApplicationRecord
  include HasOpaqueId
  include SessionOwned

  ORIGINS = %w[simulated broadcaster].freeze
  MAX_BODY_LENGTH = 500

  belongs_to :broadcast, inverse_of: :chat_messages

  validates :posted_at, presence: true
  # 投稿者ラベルは氏名・ニックネーム等を用いない非個人ラベルとする（requirements.md 11節・21節）。
  validates :author_label, presence: true
  validates :origin, presence: true, inclusion: { in: ORIGINS }
  validates :body, presence: true, length: { maximum: MAX_BODY_LENGTH }
end
