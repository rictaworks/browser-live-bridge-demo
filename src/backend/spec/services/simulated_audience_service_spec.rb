require "rails_helper"

RSpec.describe SimulatedAudienceService do
  let(:token_a) { "token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  let(:token_b) { "token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }

  describe ".viewer_count" do
    it "実時計に依存せず、同じtoken・経過時間なら常に同じ値を返すこと（決定的）" do
      value1 = described_class.viewer_count(token_a, 500)
      value2 = described_class.viewer_count(token_a, 500)

      expect(value1).to eq(value2)
    end

    it "同一配信を再度開いた場合の再現性（何度呼んでも同じ推移になること）" do
      trajectory1 = (0..600).step(30).map { |t| described_class.viewer_count(token_a, t) }
      trajectory2 = (0..600).step(30).map { |t| described_class.viewer_count(token_a, t) }

      expect(trajectory1).to eq(trajectory2)
    end

    it "配信トークンが異なれば推移も異なること" do
      trajectory_a = (0..600).step(30).map { |t| described_class.viewer_count(token_a, t) }
      trajectory_b = (0..600).step(30).map { |t| described_class.viewer_count(token_b, t) }

      expect(trajectory_a).not_to eq(trajectory_b)
    end

    it "急峻な跳躍を持たず、連続的に増減すること" do
      values = (0..1800).step(1).map { |t| described_class.viewer_count(token_a, t) }

      values.each_cons(2) do |before, after|
        expect((after - before).abs).to be <= 2
      end
    end

    it "負の経過時間・0でも例外にならず非負の値を返すこと" do
      expect(described_class.viewer_count(token_a, 0)).to be >= 0
      expect(described_class.viewer_count(token_a, -10)).to be >= 0
    end
  end

  describe ".messages_until" do
    it "経過時間0では生成されるメッセージが無いこと" do
      expect(described_class.messages_until(token_a, 0)).to eq([])
    end

    it "経過時間が増えるほど生成数が単調に増えること" do
      count_early = described_class.messages_until(token_a, 300).size
      count_later = described_class.messages_until(token_a, 3000).size

      expect(count_later).to be >= count_early
    end

    it "同じtoken・経過時間なら常に同じ内容・同じ順序を返すこと（決定的）" do
      list1 = described_class.messages_until(token_a, 3000)
      list2 = described_class.messages_until(token_a, 3000)

      expect(list1).to eq(list2)
    end

    it "生成間隔が一定値ではなく幅を持つこと" do
      list = described_class.messages_until(token_a, 5000)
      offsets = list.map { |m| m[:offset_seconds] }
      intervals = offsets.each_cons(2).map { |a, b| b - a }

      expect(intervals.uniq.size).to be > 1
    end

    it "定型文40件の中から選ばれること" do
      list = described_class.messages_until(token_a, 20_000)

      expect(list).not_to be_empty
      expect(list.map { |m| m[:body] }.uniq - described_class::TEMPLATES).to be_empty
    end

    it "投稿者ラベルが個人を特定しない記号であること" do
      list = described_class.messages_until(token_a, 3000)

      list.each do |m|
        expect(m[:author_label]).to match(/\A視聴者-[0-9A-F]{4}\z/)
      end
    end
  end

  it "定型文はちょうど40件であること（requirements.md 13.2節）" do
    expect(described_class::TEMPLATES.size).to eq(40)
  end
end
