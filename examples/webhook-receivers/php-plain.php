<?php
// Minimal PHP webhook receiver for WARest
// Run: php -S localhost:8083 examples/webhook-receivers/php-plain.php

header('Content-Type: application/json');

function algo_from_header($h) {
  $h = strtoupper($h ?? '');
  if (strpos($h, 'HMAC-SHA') === 0) {
    $bits = substr($h, 8);
    if ($bits === '224') return 'sha224';
    if ($bits === '256') return 'sha256';
    if ($bits === '384') return 'sha384';
    if ($bits === '512') return 'sha512';
  }
  return 'sha256';
}

function timing_safe_equals($a, $b) {
  if (strlen($a) !== strlen($b)) return false;
  $res = 0;
  for ($i = 0; $i < strlen($a); $i++) { $res |= ord($a[$i]) ^ ord($b[$i]); }
  return $res === 0;
}

$headers = function_exists('getallheaders') ? getallheaders() : [];
$sigHeader = $headers['X-WAREST-Signature'] ?? '';
$algHeader = $headers['X-WAREST-Signature-Alg'] ?? '';
$username = $headers['X-WAREST-Username'] ?? '';
$verifyTs = getenv('WAREST_VERIFY_TS') === '1';
$tol = intval(getenv('WAREST_TOLERANCE_SEC') ?: '300');

$raw = file_get_contents('php://input');
$parts = explode('=', $sigHeader, 2);
$hex = isset($parts[1]) ? trim($parts[1]) : '';
if (!$hex) { http_response_code(401); echo json_encode(['ok'=>false,'error'=>'missing signature']); exit; }

$algo = algo_from_header($algHeader);
$secretsRaw = getenv('WAREST_SECRET') ?: 'secret';
$secrets = array_filter(array_map('trim', explode(',', $secretsRaw)));
if (!$secrets) $secrets = ['secret'];

$ok = false;
foreach ($secrets as $s) {
  $key = $s . $username;
  $expected = hash_hmac($algo, $raw, $key);
  if (timing_safe_equals($expected, $hex)) { $ok = true; break; }
}

if ($ok && $verifyTs) {
  $ts = intval($headers['X-WAREST-Timestamp'] ?? '0');
  $now = intval(microtime(true) * 1000);
  if ($ts === 0 || abs($now - $ts) > $tol * 1000) {
    http_response_code(401);
    echo json_encode(['ok'=>false,'error'=>'stale timestamp']);
    exit;
  }
}

$body = json_decode($raw, true);
error_log("[WEBHOOK] headers: event=" . ($headers['X-WAREST-Event'] ?? '')); 
error_log("[WEBHOOK] body: " . $raw);

if (!$ok) { http_response_code(401); echo json_encode(['ok'=>false,'error'=>'bad signature']); exit; }

$resp = ['ok' => true];
if (($body['event'] ?? '') === 'message_received') {
  $text = strtolower(trim($body['data']['text'] ?? ''));
  $to = $body['data']['sender']['chatId'] ?? '';
  if ($text === 'test' && $to) {
    $resp['actions'] = [['type'=>'text','to'=>$to,'text'=>'pong']];
    $resp['delayMs'] = 600;
  }
}
echo json_encode($resp);

