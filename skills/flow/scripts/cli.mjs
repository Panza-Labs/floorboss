#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The flow: `next` says the one thing to do now; `answer` saves what the user said where it belongs.
// Claude never chooses where an answer is saved: each question id has one saver here.
import { run } from '../../../lib/args.mjs';
import { next } from './next.mjs';
import { answer, ids } from './answer.mjs';

run({ next, answer, asks: ids });
