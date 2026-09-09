# 配信1本（requirements.md 13〜14節・18.1節の状態遷移）。
class Broadcast < ApplicationRecord
  include HasOpaqueId
  include SessionOwned

  # 18.1節の状態遷移図に対応する配信状態。Idleは永続化前（レコード未作成）の状態。
  STATES = %w[preparing ready connecting live degraded reconnecting stopping failed ended].freeze
  ACTIVE_STATES = (STATES - %w[ended failed]).freeze

  belongs_to :session, foreign_key: :session_id, primary_key: :session_id, inverse_of: :broadcasts
  has_many :broadcast_sources, dependent: nil
  has_many :health_samples, dependent: nil
  has_many :broadcast_events, dependent: nil
  has_many :audience_samples, dependent: nil
  has_many :chat_messages, dependent: nil

  validates :broadcast_token, presence: true, uniqueness: true
  validates :layout_preset, presence: true
  validates :state, presence: true, inclusion: { in: STATES }
  validates :started_at, presence: true

  def ended?
    %w[ended failed].include?(state)
  end

  def elapsed_seconds(now: Time.current)
    [ (now - started_at).to_i, 0 ].max
  end
end
