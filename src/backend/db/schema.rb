# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_09_10_000008) do
  create_table "audience_samples", id: :string, force: :cascade do |t|
    t.string "broadcast_id", null: false
    t.datetime "sampled_at", null: false
    t.string "session_id", null: false
    t.integer "viewer_count", null: false
    t.index ["broadcast_id", "sampled_at"], name: "index_audience_samples_on_broadcast_id_and_sampled_at"
    t.index ["session_id"], name: "index_audience_samples_on_session_id"
  end

  create_table "broadcast_events", id: :string, force: :cascade do |t|
    t.string "broadcast_id", null: false
    t.string "detail"
    t.string "event_type", null: false
    t.datetime "occurred_at", null: false
    t.string "session_id", null: false
    t.index ["broadcast_id", "occurred_at"], name: "index_broadcast_events_on_broadcast_id_and_occurred_at"
    t.index ["session_id"], name: "index_broadcast_events_on_session_id"
  end

  create_table "broadcast_locks", primary_key: "session_id", id: :string, force: :cascade do |t|
    t.datetime "acquired_at", null: false
    t.string "broadcast_id", null: false
    t.datetime "heartbeat_at", null: false
    t.index ["broadcast_id"], name: "index_broadcast_locks_on_broadcast_id", unique: true
  end

  create_table "broadcast_sources", id: :string, force: :cascade do |t|
    t.datetime "attached_at"
    t.string "broadcast_id", null: false
    t.datetime "created_at", null: false
    t.datetime "detached_at"
    t.boolean "enabled", default: true, null: false
    t.string "kind", null: false
    t.string "role", null: false
    t.string "session_id", null: false
    t.datetime "updated_at", null: false
    t.index ["broadcast_id", "kind"], name: "index_broadcast_sources_on_broadcast_id_and_kind", unique: true
    t.index ["broadcast_id"], name: "index_broadcast_sources_on_broadcast_id"
    t.index ["session_id"], name: "index_broadcast_sources_on_session_id"
  end

  create_table "broadcasts", id: :string, force: :cascade do |t|
    t.string "broadcast_token", null: false
    t.datetime "created_at", null: false
    t.datetime "ended_at"
    t.string "ended_reason"
    t.string "layout_preset", null: false
    t.string "session_id", null: false
    t.datetime "started_at", null: false
    t.string "state", default: "preparing", null: false
    t.string "title"
    t.datetime "updated_at", null: false
    t.index ["broadcast_token"], name: "index_broadcasts_on_broadcast_token", unique: true
    t.index ["session_id"], name: "index_broadcasts_on_session_id"
  end

  create_table "chat_messages", id: :string, force: :cascade do |t|
    t.string "author_label", null: false
    t.text "body", null: false
    t.string "broadcast_id", null: false
    t.string "origin", null: false
    t.datetime "posted_at", null: false
    t.string "session_id", null: false
    t.index ["broadcast_id", "posted_at"], name: "index_chat_messages_on_broadcast_id_and_posted_at"
    t.index ["session_id"], name: "index_chat_messages_on_session_id"
  end

  create_table "health_samples", id: :string, force: :cascade do |t|
    t.string "broadcast_id", null: false
    t.integer "dropped_audio_frames", default: 0, null: false
    t.integer "dropped_video_frames", default: 0, null: false
    t.integer "queue_ms", null: false
    t.datetime "sampled_at", null: false
    t.integer "sent_bitrate_kbps", null: false
    t.string "session_id", null: false
    t.string "state", null: false
    t.integer "target_bitrate_kbps", null: false
    t.index ["broadcast_id", "sampled_at"], name: "index_health_samples_on_broadcast_id_and_sampled_at"
    t.index ["session_id"], name: "index_health_samples_on_session_id"
  end

  create_table "sessions", primary_key: "session_id", id: :string, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "last_seen_at", null: false
    t.string "user_agent_class", default: "unknown", null: false
  end
end
