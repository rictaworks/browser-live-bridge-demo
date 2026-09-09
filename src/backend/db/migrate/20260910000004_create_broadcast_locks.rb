# セッション単位の配信ロック（requirements.md 9節）。
# session_id自体がオーナーキー兼主キーであり、1セッションにつき同時に1件しか存在し得ない。
class CreateBroadcastLocks < ActiveRecord::Migration[8.1]
  def change
    create_table :broadcast_locks, id: :string, primary_key: :session_id do |t|
      t.string :broadcast_id, null: false
      t.datetime :acquired_at, null: false
      t.datetime :heartbeat_at, null: false
    end

    add_index :broadcast_locks, :broadcast_id, unique: true
  end
end
