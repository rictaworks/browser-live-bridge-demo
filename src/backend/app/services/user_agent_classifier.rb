# sessions.user_agent_class は「ブラウザ種別の分類のみ」を保持する（requirements.md 14節ER図の注記）。
# 個体識別に使える生のUser-Agent文字列そのものは保存しない。
class UserAgentClassifier
  def self.classify(user_agent)
    return "unknown" if user_agent.blank?

    case user_agent
    when /Edg\//i then "edge"
    when /OPR\/|Opera/i then "opera"
    when /Chrome\//i then "chrome"
    when /Firefox\//i then "firefox"
    when /Safari\//i then "safari"
    else "other"
    end
  end
end
