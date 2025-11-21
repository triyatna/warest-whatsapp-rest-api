// Minimal Go webhook receiver for WARest
// Build: go run go-http.go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "crypto/sha512"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "strconv"
    "strings"
    "time"
)

type Envelope struct {
    Event   string                 `json:"event"`
    Data    map[string]interface{} `json:"data"`
    Ts      int64                  `json:"ts"`
    Session map[string]interface{} `json:"session"`
}

func algoFromHeader(h string) string {
    h = strings.ToUpper(h)
    if strings.HasPrefix(h, "HMAC-SHA") {
        bits := strings.TrimPrefix(h, "HMAC-SHA")
        switch bits {
        case "224":
            return "sha224"
        case "256":
            return "sha256"
        case "384":
            return "sha384"
        case "512":
            return "sha512"
        }
    }
    return "sha256"
}

func hmacHex(algo string, key, body []byte) string {
    var mac hashFunc
    switch algo {
    case "sha224":
        mac = func(k, b []byte) []byte { h := hmac.New(sha256.New224, k); h.Write(b); return h.Sum(nil) }
    case "sha384":
        mac = func(k, b []byte) []byte { h := hmac.New(sha512.New384, k); h.Write(b); return h.Sum(nil) }
    case "sha512":
        mac = func(k, b []byte) []byte { h := hmac.New(sha512.New, k); h.Write(b); return h.Sum(nil) }
    default:
        mac = func(k, b []byte) []byte { h := hmac.New(sha256.New, k); h.Write(b); return h.Sum(nil) }
    }
    sum := mac(key, body)
    return hex.EncodeToString(sum)
}

type hashFunc func(k, b []byte) []byte

func verify(r *http.Request, raw []byte) bool {
    sigHeader := r.Header.Get("X-WAREST-Signature")
    algHeader := r.Header.Get("X-WAREST-Signature-Alg")
    username := r.Header.Get("X-WAREST-Username")
    parts := strings.SplitN(sigHeader, "=", 2)
    if len(parts) != 2 || parts[1] == "" {
        return false
    }
    hexsig := parts[1]

    secrets := strings.Split(os.Getenv("WAREST_SECRET"), ",")
    if len(secrets) == 0 || (len(secrets) == 1 && secrets[0] == "") {
        secrets = []string{"secret"}
    }
    algo := algoFromHeader(algHeader)
    for _, s := range secrets {
        key := []byte(s + username)
        expected := hmacHex(algo, key, raw)
        if subtleConstantTimeEqual(expected, hexsig) {
            return true
        }
    }
    return false
}

func subtleConstantTimeEqual(a, b string) bool {
    if len(a) != len(b) {
        return false
    }
    // Constant-time compare
    var res byte = 0
    for i := 0; i < len(a); i++ {
        res |= a[i] ^ b[i]
    }
    return res == 0
}

func handler(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        w.WriteHeader(http.StatusMethodNotAllowed)
        return
    }
    raw, err := io.ReadAll(r.Body)
    if err != nil {
        w.WriteHeader(http.StatusBadRequest)
        return
    }
    ok := verify(r, raw)
    if ok && os.Getenv("WAREST_VERIFY_TS") == "1" {
        tsStr := r.Header.Get("X-WAREST-Timestamp")
        ts, _ := strconv.ParseInt(tsStr, 10, 64)
        tol, _ := strconv.Atoi(os.Getenv("WAREST_TOLERANCE_SEC"))
        if tol == 0 {
            tol = 300
        }
        now := time.Now().UnixMilli()
        if ts == 0 || abs64(now-ts) > int64(tol*1000) {
            w.WriteHeader(http.StatusUnauthorized)
            w.Header().Set("Content-Type", "application/json")
            fmt.Fprintf(w, `{"ok":false,"error":"stale timestamp"}`)
            return
        }
    }

    var env Envelope
    _ = json.Unmarshal(raw, &env)
    log.Printf("[WEBHOOK] headers: event=%s session=%v", env.Event, r.Header.Get("X-WAREST-Session"))
    log.Printf("[WEBHOOK] body: %s", string(raw))

    if !ok {
        w.WriteHeader(http.StatusUnauthorized)
        w.Header().Set("Content-Type", "application/json")
        fmt.Fprintf(w, `{"ok":false,"error":"bad signature"}`)
        return
    }

    // Optional actions example
    resp := map[string]interface{}{"ok": true}
    if env.Event == "message_received" {
        if dataText, ok := env.Data["text"].(string); ok {
            to := ""
            if sender, ok := env.Data["sender"].(map[string]interface{}); ok {
                if chatId, ok := sender["chatId"].(string); ok {
                    to = chatId
                }
            }
            if strings.ToLower(strings.TrimSpace(dataText)) == "test" && to != "" {
                resp["actions"] = []map[string]interface{}{{"type": "text", "to": to, "text": "pong"}}
                resp["delayMs"] = 600
            }
        }
    }

    w.Header().Set("Content-Type", "application/json")
    enc := json.NewEncoder(w)
    enc.Encode(resp)
}

func abs64(x int64) int64 { if x < 0 { return -x }; return x }

func main() {
    port := os.Getenv("PORT")
    if port == "" { port = "8082" }
    http.HandleFunc("/webhook", handler)
    log.Printf("[receiver] listening on http://localhost:%s/webhook", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}

