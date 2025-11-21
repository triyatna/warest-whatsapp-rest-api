# Minimal Sinatra webhook receiver for WARest
# run: PORT=8084 WAREST_SECRET=secret ruby examples/webhook-receivers/ruby-sinatra.rb

require 'sinatra'
require 'json'
require 'openssl'

set :bind, '0.0.0.0'
set :port, (ENV['PORT'] || '8084').to_i

def algo_from_header(h)
  h = (h || '').upcase
  return 'sha256' unless h.start_with?('HMAC-SHA')
  bits = h.sub('HMAC-SHA', '')
  case bits
  when '224' then 'sha224'
  when '256' then 'sha256'
  when '384' then 'sha384'
  when '512' then 'sha512'
  else 'sha256'
  end
end

post '/webhook' do
  raw = request.body.read || ''
  sig = request.env['HTTP_X_WAREST_SIGNATURE'] || ''
  alg = request.env['HTTP_X_WAREST_SIGNATURE_ALG'] || ''
  user = request.env['HTTP_X_WAREST_USERNAME'] || ''

  parts = sig.split('=')
  hex = (parts[1] || '').strip
  halt 401, { ok: false, error: 'missing signature' }.to_json if hex.empty?

  secrets = (ENV['WAREST_SECRET'] || 'secret').split(',').map(&:strip).reject(&:empty?)
  algo = algo_from_header(alg)
  ok = secrets.any? do |s|
    key = s + user
    expected = OpenSSL::HMAC.hexdigest(algo, key, raw)
    Rack::Utils.secure_compare(expected, hex) rescue false
  end
  halt 401, { ok: false, error: 'bad signature' }.to_json unless ok

  begin
    body = JSON.parse(raw)
  rescue
    body = {}
  end
  headers 'Content-Type' => 'application/json'
  if (ENV['WAREST_VERIFY_TS'] == '1')
    ts = (request.env['HTTP_X_WAREST_TIMESTAMP'] || '0').to_i
    tol = (ENV['WAREST_TOLERANCE_SEC'] || '300').to_i
    now = (Time.now.to_f * 1000).to_i
    if ts == 0 || (now - ts).abs > tol * 1000
      halt 401, { ok: false, error: 'stale timestamp' }.to_json
    end
  end

  if body['event'] == 'message_received'
    text = (body.dig('data', 'text') || '').strip.downcase
    to = body.dig('data', 'sender', 'chatId')
    if text == 'test' && to
      return { ok: true, actions: [ { type: 'text', to: to, text: 'pong' } ], delayMs: 600 }.to_json
    end
  end
  { ok: true }.to_json
end

