"""Snapshot-only AES-256-GCM and explicit key recovery helpers.

The companion cannot assume a Python package manager exists on a recovered Mac.
This module therefore keeps the small AES-GCM primitive dependency-free and
cross-checks it in the focused harness against the Web Crypto implementation.
Key material is never included in manifests or HTTP responses.
"""
from __future__ import annotations

import base64
import hmac
import os
import secrets
import subprocess
from pathlib import Path
from typing import Protocol

MAGIC = b"SCROLLMARK-AESGCM1\x00"
NONCE_BYTES = 12
TAG_BYTES = 16
KEY_BYTES = 32
KEYCHAIN_SERVICE = "com.scrollmark.companion.snapshot"

_SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16"
)
_RCON = (0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54)


def _xtime(value: int) -> int:
    return ((value << 1) ^ (0x11B if value & 0x80 else 0)) & 0xFF


def _expand_key(key: bytes) -> list[bytes]:
    if len(key) != KEY_BYTES:
        raise ValueError("AES-256 requires a 32-byte key")
    words = [list(key[offset : offset + 4]) for offset in range(0, len(key), 4)]
    for index in range(8, 60):
        temp = words[index - 1][:]
        if index % 8 == 0:
            temp = temp[1:] + temp[:1]
            temp = [_SBOX[value] for value in temp]
            temp[0] ^= _RCON[index // 8]
        elif index % 8 == 4:
            temp = [_SBOX[value] for value in temp]
        words.append([words[index - 8][position] ^ temp[position] for position in range(4)])
    return [bytes(sum(words[offset : offset + 4], [])) for offset in range(0, 60, 4)]


def _add_round_key(state: list[int], key: bytes) -> None:
    for index, value in enumerate(key):
        state[index] ^= value


def _sub_bytes(state: list[int]) -> None:
    for index, value in enumerate(state):
        state[index] = _SBOX[value]


def _shift_rows(state: list[int]) -> None:
    original = state[:]
    for row in range(4):
        for column in range(4):
            state[row + 4 * column] = original[row + 4 * ((column + row) % 4)]


def _mix_columns(state: list[int]) -> None:
    for column in range(4):
        offset = column * 4
        a0, a1, a2, a3 = state[offset : offset + 4]
        total = a0 ^ a1 ^ a2 ^ a3
        state[offset] = a0 ^ total ^ _xtime(a0 ^ a1)
        state[offset + 1] = a1 ^ total ^ _xtime(a1 ^ a2)
        state[offset + 2] = a2 ^ total ^ _xtime(a2 ^ a3)
        state[offset + 3] = a3 ^ total ^ _xtime(a3 ^ a0)


def _encrypt_block(key_schedule: list[bytes], block: bytes) -> bytes:
    if len(block) != 16:
        raise ValueError("AES blocks are 16 bytes")
    state = list(block)
    _add_round_key(state, key_schedule[0])
    for round_index in range(1, 14):
        _sub_bytes(state)
        _shift_rows(state)
        _mix_columns(state)
        _add_round_key(state, key_schedule[round_index])
    _sub_bytes(state)
    _shift_rows(state)
    _add_round_key(state, key_schedule[14])
    return bytes(state)


def _blocks(value: bytes):
    for offset in range(0, len(value), 16):
        block = value[offset : offset + 16]
        yield block + b"\x00" * (16 - len(block))


def _gf_multiply(left: int, right: int) -> int:
    result = 0
    value = right
    for bit in range(128):
        if left & (1 << (127 - bit)):
            result ^= value
        value = (value >> 1) ^ (0xE1000000000000000000000000000000 if value & 1 else 0)
    return result


def _ghash(hash_subkey: bytes, aad: bytes, ciphertext: bytes) -> bytes:
    result = 0
    multiplier = int.from_bytes(hash_subkey, "big")
    for block in [*_blocks(aad), *_blocks(ciphertext)]:
        result = _gf_multiply(result ^ int.from_bytes(block, "big"), multiplier)
    lengths = (len(aad) * 8).to_bytes(8, "big") + (len(ciphertext) * 8).to_bytes(8, "big")
    result = _gf_multiply(result ^ int.from_bytes(lengths, "big"), multiplier)
    return result.to_bytes(16, "big")


def _increment_counter(counter: bytes) -> bytes:
    return counter[:12] + ((int.from_bytes(counter[12:], "big") + 1) & 0xFFFFFFFF).to_bytes(4, "big")


def _gctr(key_schedule: list[bytes], initial_counter: bytes, value: bytes) -> bytes:
    output = bytearray()
    counter = initial_counter
    for offset in range(0, len(value), 16):
        block = value[offset : offset + 16]
        mask = _encrypt_block(key_schedule, counter)
        output.extend(left ^ right for left, right in zip(block, mask))
        counter = _increment_counter(counter)
    return bytes(output)


def aes256_gcm_encrypt(key: bytes, plaintext: bytes, aad: bytes, nonce: bytes | None = None) -> bytes:
    nonce = nonce or secrets.token_bytes(NONCE_BYTES)
    if len(nonce) != NONCE_BYTES:
        raise ValueError("snapshot AES-GCM nonce must be 12 bytes")
    schedule = _expand_key(key)
    hash_subkey = _encrypt_block(schedule, b"\x00" * 16)
    initial = nonce + b"\x00\x00\x00\x01"
    ciphertext = _gctr(schedule, _increment_counter(initial), plaintext)
    auth = _ghash(hash_subkey, aad, ciphertext)
    tag = bytes(left ^ right for left, right in zip(_encrypt_block(schedule, initial), auth))
    return MAGIC + nonce + tag + ciphertext


def aes256_gcm_decrypt(key: bytes, payload: bytes, aad: bytes) -> bytes:
    if len(key) != KEY_BYTES:
        raise ValueError("AES-256 requires a 32-byte key")
    if not payload.startswith(MAGIC) or len(payload) < len(MAGIC) + NONCE_BYTES + TAG_BYTES:
        raise ValueError("encrypted snapshot image framing is invalid")
    offset = len(MAGIC)
    nonce = payload[offset : offset + NONCE_BYTES]
    tag = payload[offset + NONCE_BYTES : offset + NONCE_BYTES + TAG_BYTES]
    ciphertext = payload[offset + NONCE_BYTES + TAG_BYTES :]
    schedule = _expand_key(key)
    initial = nonce + b"\x00\x00\x00\x01"
    auth = _ghash(_encrypt_block(schedule, b"\x00" * 16), aad, ciphertext)
    expected = bytes(left ^ right for left, right in zip(_encrypt_block(schedule, initial), auth))
    if not hmac.compare_digest(tag, expected):
        raise ValueError("encrypted snapshot authentication failed")
    return _gctr(schedule, _increment_counter(initial), ciphertext)


def encode_recovery_key(key: bytes) -> str:
    if len(key) != KEY_BYTES:
        raise ValueError("snapshot recovery key must be 32 bytes")
    return base64.urlsafe_b64encode(key).decode("ascii").rstrip("=")


def decode_recovery_key(value: str) -> bytes:
    normalized = value.strip()
    try:
        key = base64.urlsafe_b64decode(normalized + "=" * (-len(normalized) % 4))
    except Exception as error:
        raise ValueError("snapshot recovery key is invalid") from error
    if len(key) != KEY_BYTES:
        raise ValueError("snapshot recovery key is invalid")
    return key


class SnapshotKeyStore(Protocol):
    def put(self, key_id: str, key: bytes) -> None: ...
    def get(self, key_id: str) -> bytes: ...


class InMemorySnapshotKeyStore:
    """Focused-harness key store; production callers use macOS Keychain."""

    def __init__(self) -> None:
        self._keys: dict[str, bytes] = {}

    def put(self, key_id: str, key: bytes) -> None:
        self._keys[key_id] = bytes(key)

    def get(self, key_id: str) -> bytes:
        try:
            return self._keys[key_id]
        except KeyError as error:
            raise ValueError("snapshot key is unavailable") from error


class MacOSKeychainSnapshotKeyStore:
    def __init__(self, service: str = KEYCHAIN_SERVICE) -> None:
        self.service = service

    def put(self, key_id: str, key: bytes) -> None:
        if os.uname().sysname != "Darwin":
            raise ValueError("macOS Keychain is unavailable")
        subprocess.run(
            [
                "/usr/bin/security",
                "add-generic-password",
                "-U",
                "-a",
                key_id,
                "-s",
                self.service,
                "-w",
                encode_recovery_key(key),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def get(self, key_id: str) -> bytes:
        if os.uname().sysname != "Darwin":
            raise ValueError("macOS Keychain is unavailable")
        try:
            result = subprocess.run(
                [
                    "/usr/bin/security",
                    "find-generic-password",
                    "-a",
                    key_id,
                    "-s",
                    self.service,
                    "-w",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as error:
            raise ValueError("snapshot key is unavailable") from error
        return decode_recovery_key(result.stdout)


def write_recovery_key(path: Path, key: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, (encode_recovery_key(key) + "\n").encode("ascii"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


__all__ = [
    "InMemorySnapshotKeyStore",
    "MacOSKeychainSnapshotKeyStore",
    "SnapshotKeyStore",
    "aes256_gcm_decrypt",
    "aes256_gcm_encrypt",
    "decode_recovery_key",
    "encode_recovery_key",
    "write_recovery_key",
]
