# 擬似チャットおよび配信者の投稿（requirements.md 11節・13〜14節）。
class CreateChatMessages < ActiveRecord::Migration[8.1]
  def change
    create_table :chat_messages, id: :string do |t|
      t.string :session_id, null: false
      t.string :broadcast_id, null: false
      t.datetime :posted_at, null: false
      t.string :author_label, null: false
      t.string :origin, null: false
      t.text :body, null: false
    end

    add_index :chat_messages, :session_id
    add_index :chat_messages, %i[broadcast_id posted_at]
  end
end
