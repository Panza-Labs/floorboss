// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A hard time limit for the scheduled launcher. It runs as a second thread, because the launcher's own work is
// synchronous: a read that never returns would hold up any timer on the launcher's own thread. When the limit
// passes it ends the whole process, and does nothing else first: anything it tried before that (a line in the
// log) could be the very thing that hangs. The launcher's next run finds the mark the stopped one left
// (unattended/brief-running) and says so in the log then.
import { workerData, isMainThread } from 'node:worker_threads';

if (!isMainThread && Number.isFinite(workerData?.ms)) setTimeout(() => process.kill(process.pid, 'SIGKILL'), workerData.ms);
