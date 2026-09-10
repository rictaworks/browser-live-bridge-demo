// Command testclient は test/pr7 のシェルスクリプトから起動される、実際に稼働している
// relayコンテナに対する結合確認用の使い捨てWebSocketクライアントです。
//
// 位置づけ:
//   - src/relay/internal/wsapi/full_pipeline_test.go は「配信開始→中継到達→モニター再生」
//     「接続断からの再接続」をGoのhttptestサーバー＋フェイクbackendで検証済みです（issue #4で
//     本PR内に実装済み）。
//   - 本プログラムは、それと同じプロトコル手順を、実際に docker compose で起動している
//     relayコンテナ（backend コンテナへ本物のHTTPで検証しにいく実装）に対して行い、
//     3層が実プロセス・実ネットワークで結合していることを補完的に確認します。
//     （test/pr6のREADMEで「issue #4で行う」とされていた範囲です）
//
// 実行方法（このファイル自体はビルドタグ等で通常のrelayビルドに含まれません。
// test/pr7/run_full_pipeline_and_reconnect.sh が、docker compose run で
// このディレクトリを一時的に src/relay モジュール内のパス（/app/cmd/testclient）に
// バインドマウントしてから `go run ./cmd/testclient` で実行します。
// src/relay 配下のファイルは一切変更しません）。
//
// go.mod・go.sumが定義するmoduleパス（github.com/rictaworks/browser-live-bridge-demo/relay）
// の一部として実行されるため、internal/ 配下のパッケージをそのまま再利用できます。
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/gorilla/websocket"
	flvtag "github.com/yutopp/go-flv/tag"

	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/ingest"
	"github.com/rictaworks/browser-live-bridge-demo/relay/internal/protocol"
)

func main() {
	mode := flag.String("mode", "pipeline", "pipeline | reject")
	relayBase := flag.String("relay", "ws://relay:3002", "relayのWebSocketベースURL")
	sessionKey := flag.String("session-key", "", "配信作成時のsession_key")
	broadcastToken := flag.String("broadcast-token", "", "配信作成時のbroadcast_token")
	flag.Parse()

	if *sessionKey == "" || *broadcastToken == "" {
		fail("session-key・broadcast-tokenは必須です")
	}

	switch *mode {
	case "pipeline":
		runPipeline(*relayBase, *sessionKey, *broadcastToken)
	case "reject":
		runReject(*relayBase, *sessionKey, *broadcastToken)
	default:
		fail(fmt.Sprintf("不明なmode: %s", *mode))
	}
}

func fail(msg string) {
	fmt.Println("RESULT=FAIL: " + msg)
	os.Exit(1)
}

func pass(msg string) {
	fmt.Println("RESULT=PASS: " + msg)
}

// --- pipelineモード ---------------------------------------------------------
//
// 1. /ws/publish に接続し、開始通知→受領応答→映像/音声設定→キーフレーム要求→
//    キーフレーム送出、という実際の中継サーバー（backendへ本物のHTTPで照合しにいく）
//    との一連のやり取りを行う。
// 2. /ws/monitor/:broadcast_token に接続し、送出したキーフレームがFLVタグとして
//    バイト単位で届くことを確認する。
// 3. 終了通知を送らずに publish 接続を閉じ（接続断のシミュレーション）、
//    同一 broadcast_token で新規に publish 接続をやり直す（再接続シナリオ）。
// 4. 新しい publish 接続で送出したキーフレームが、新しい monitor 接続でも
//    バイト単位で確認できることを確認する。
// 5. 終了通知を送って正常終了する。
func runPipeline(relayBase, sessionKey, broadcastToken string) {
	studio1, err := dial(relayBase + "/ws/publish")
	if err != nil {
		fail("1本目のpublish接続に失敗: " + err.Error())
	}

	if err := publishHandshake(studio1, sessionKey, broadcastToken, "pr7-before-disconnect"); err != nil {
		studio1.Close()
		fail("1本目のpublishハンドシェイクに失敗: " + err.Error())
	}

	if err := waitForKeyframeOnMonitor(relayBase, broadcastToken, "pr7-before-disconnect"); err != nil {
		studio1.Close()
		fail("1本目のキーフレームがモニターに届きませんでした: " + err.Error())
	}
	fmt.Println("STEP=PASS: 配信開始→中継到達→モニター再生の疎通を確認しました")

	// 接続断のシミュレーション: 終了通知を送らずにそのまま閉じる。
	studio1.Close()
	time.Sleep(300 * time.Millisecond)

	studio2, err := dial(relayBase + "/ws/publish")
	if err != nil {
		fail("再接続（2本目のpublish接続）に失敗: " + err.Error())
	}
	defer studio2.Close()

	if err := publishHandshake(studio2, sessionKey, broadcastToken, "pr7-after-reconnect"); err != nil {
		fail("再接続後のpublishハンドシェイクに失敗: " + err.Error())
	}

	if err := waitForKeyframeOnMonitor(relayBase, broadcastToken, "pr7-after-reconnect"); err != nil {
		fail("再接続後のキーフレームがモニターに届きませんでした: " + err.Error())
	}
	fmt.Println("STEP=PASS: 接続断からの再接続シナリオ（16.3節）を確認しました")

	if err := sendFrame(studio2, protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeEndNotice(protocol.EndNotice{Reason: "pr7_user_test"}),
	}); err != nil {
		fail("終了通知の送信に失敗: " + err.Error())
	}

	pass("配信開始→中継到達→モニター再生、および接続断からの再接続シナリオを実サーバーで確認しました")
}

// --- rejectモード -------------------------------------------------------
//
// オーナーキー分離（requirements.md 9節・21節）のWebSocket/内部API層での確認。
// 実在する配信のsession_key・broadcast_tokenのどちらかが誤った組み合わせで
// 開始通知を送ると、中継サーバーが実際のbackendへの照合（POST /internal/broadcasts/verify）
// の結果として致命通知（verification_failed）を返し、接続を閉じることを確認する。
func runReject(relayBase, sessionKey, broadcastToken string) {
	conn, err := dial(relayBase + "/ws/publish")
	if err != nil {
		fail("publish接続に失敗: " + err.Error())
	}
	defer conn.Close()

	if err := sendFrame(conn, protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeStartNotice(protocol.StartNotice{
			SessionKey:     sessionKey,
			BroadcastToken: broadcastToken,
			EncodeProfile:  "h264-baseline-3.1",
		}),
	}); err != nil {
		fail("開始通知の送信に失敗: " + err.Error())
	}

	frame, err := readFrame(conn, 5*time.Second)
	if err != nil {
		fail("応答の受信に失敗（致命通知が返らず切断された可能性があります）: " + err.Error())
	}

	ct, err := protocol.PeekControlType(frame.Body)
	if err != nil {
		fail("応答フレームの制御種別を読み取れませんでした: " + err.Error())
	}

	switch ct {
	case protocol.ControlAck:
		fail("不正なsession_key/broadcast_tokenの組み合わせが受領応答（Ack）されました。オーナーキー分離が機能していません")
	case protocol.ControlFatal:
		notice, derr := protocol.DecodeFatal(frame.Body)
		if derr == nil && notice.Reason == "verification_failed" {
			pass("不正なsession_key/broadcast_tokenの組み合わせが致命通知（verification_failed）で拒否されました")
			return
		}
		pass("不正な組み合わせが致命通知で拒否されました（reason取得は失敗: " + fmt.Sprint(derr) + "）")
	default:
		fail(fmt.Sprintf("想定外の応答種別でした: %v", ct))
	}
}

// --- 補助関数 ---------------------------------------------------------------

func dial(url string) (*websocket.Conn, error) {
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	return conn, err
}

func sendFrame(conn *websocket.Conn, f protocol.Frame) error {
	encoded, err := protocol.Encode(f)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, encoded)
}

func readFrame(conn *websocket.Conn, timeout time.Duration) (protocol.Frame, error) {
	conn.SetReadDeadline(time.Now().Add(timeout))
	_, data, err := conn.ReadMessage()
	if err != nil {
		return protocol.Frame{}, err
	}
	return protocol.Decode(data)
}

// publishHandshake は開始通知→受領応答→映像/音声設定→キーフレーム要求→
// キーフレーム＋音声フレーム送出、という/ws/publishの一連のやり取りを行う。
func publishHandshake(conn *websocket.Conn, sessionKey, broadcastToken, keyframePayload string) error {
	if err := sendFrame(conn, protocol.Frame{
		Kind: protocol.KindControl,
		Body: protocol.EncodeStartNotice(protocol.StartNotice{
			SessionKey:     sessionKey,
			BroadcastToken: broadcastToken,
			EncodeProfile:  "h264-baseline-3.1",
		}),
	}); err != nil {
		return fmt.Errorf("開始通知の送信: %w", err)
	}

	ack, err := readFrame(conn, 5*time.Second)
	if err != nil {
		return fmt.Errorf("受領応答の受信: %w", err)
	}
	if ct, err := protocol.PeekControlType(ack.Body); err != nil || ct != protocol.ControlAck {
		if ct == protocol.ControlFatal {
			notice, _ := protocol.DecodeFatal(ack.Body)
			return fmt.Errorf("開始通知が拒否されました（reason=%s）。実在する配信のsession_key/broadcast_tokenか確認してください", notice.Reason)
		}
		return fmt.Errorf("受領応答ではないフレームを受信しました（種別=%v, err=%v）", ct, err)
	}

	if err := sendFrame(conn, protocol.Frame{Kind: protocol.KindVideoConfig, Body: []byte{0x01, 0x42, 0xC0, 0x1F}}); err != nil {
		return fmt.Errorf("映像設定の送信: %w", err)
	}
	if err := sendFrame(conn, protocol.Frame{Kind: protocol.KindAudioConfig, Body: []byte{0x11, 0x90}}); err != nil {
		return fmt.Errorf("音声設定の送信: %w", err)
	}

	kfReq, err := readFrame(conn, 5*time.Second)
	if err != nil {
		return fmt.Errorf("キーフレーム要求の受信: %w", err)
	}
	if ct, err := protocol.PeekControlType(kfReq.Body); err != nil || ct != protocol.ControlKeyframeRequest {
		return fmt.Errorf("キーフレーム要求ではないフレームを受信しました（種別=%v, err=%v）", ct, err)
	}

	if err := sendFrame(conn, protocol.Frame{
		Kind: protocol.KindVideo, KeyFrame: true, TimestampMicros: 0, Body: []byte(keyframePayload),
	}); err != nil {
		return fmt.Errorf("キーフレームの送信: %w", err)
	}
	if err := sendFrame(conn, protocol.Frame{
		Kind: protocol.KindAudio, TimestampMicros: 0, Body: []byte("pr7-audio"),
	}); err != nil {
		return fmt.Errorf("音声フレームの送信: %w", err)
	}
	return nil
}

// waitForKeyframeOnMonitor は /ws/monitor/:broadcast_token に接続し、
// FLVヘッダ・タグを実際にデコードして、指定payloadを持つ映像タグが届くことを
// 確認する。ローカルingestへの到達（RTMP publish・多重化）は非同期のため、
// 何回か接続をやり直しながら一定時間内にキーフレームを探す。
func waitForKeyframeOnMonitor(relayBase, broadcastToken, wantPayload string) error {
	deadline := time.Now().Add(8 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		found, err := tryReadKeyframeOnce(relayBase, broadcastToken, wantPayload)
		if err == nil && found {
			return nil
		}
		if err != nil {
			lastErr = err
		}
		time.Sleep(200 * time.Millisecond)
	}
	if lastErr != nil {
		return fmt.Errorf("タイムアウトしました（直近のエラー: %v）", lastErr)
	}
	return fmt.Errorf("タイムアウトしました（payload=%s のキーフレームが見つかりませんでした）", wantPayload)
}

func tryReadKeyframeOnce(relayBase, broadcastToken, wantPayload string) (bool, error) {
	conn, err := dial(relayBase + "/ws/monitor/" + broadcastToken)
	if err != nil {
		return false, err
	}
	defer conn.Close()

	header, err := readExactBinary(conn)
	if err != nil {
		return false, err
	}
	if !bytes.Equal(header, ingest.FlvHeader()) {
		return false, fmt.Errorf("先頭メッセージがFLVヘッダではありません")
	}
	if _, err := readExactBinary(conn); err != nil { // PreviousTagSize0（4byte）
		return false, err
	}

	for i := 0; i < 5; i++ {
		tagBytes, err := readExactBinary(conn)
		if err != nil {
			return false, nil // このタイミングでは届いていない。呼び出し側でリトライする
		}
		var ft flvtag.FlvTag
		if err := flvtag.DecodeFlvTag(bytes.NewReader(tagBytes), &ft); err != nil {
			return false, fmt.Errorf("FLVタグのデコードに失敗: %w", err)
		}
		if vd, ok := ft.Data.(*flvtag.VideoData); ok {
			buf := new(bytes.Buffer)
			buf.ReadFrom(vd.Data)
			vd.Close()
			if buf.String() == wantPayload {
				return true, nil
			}
		}
		if _, err := readExactBinary(conn); err != nil { // 対応するPreviousTagSize
			return false, nil
		}
	}
	return false, nil
}

func readExactBinary(conn *websocket.Conn) ([]byte, error) {
	conn.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
	mt, data, err := conn.ReadMessage()
	if err != nil {
		return nil, err
	}
	if mt != websocket.BinaryMessage {
		return nil, fmt.Errorf("バイナリメッセージ以外を受信しました（type=%d）", mt)
	}
	return data, nil
}
