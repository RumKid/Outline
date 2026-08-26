(function (root) {
  function b64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }

  function unb64(value) {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
  }

  async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const rawKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encrypt(key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(JSON.stringify(value))
    );
    return { iv: b64(iv), data: b64(ciphertext) };
  }

  async function decrypt(key, payload) {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(payload.iv) },
      key,
      unb64(payload.data)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  const api = { b64, unb64, deriveKey, encrypt, decrypt };
  root.OutlineAuthCrypto = api;
  if (root !== globalThis) globalThis.OutlineAuthCrypto = api;
})(typeof window === 'object' ? window : globalThis);
