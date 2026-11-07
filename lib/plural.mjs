// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A count with its noun, as a person writes it: "1 person", "3 people", "1 message", "2 messages".
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
