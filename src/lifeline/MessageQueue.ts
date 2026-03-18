/**
 * Message Queue — buffers Telegram messages when the server is down.
 *
 * Messages are persisted to disk so they survive lifeline restarts.
 * When the server comes back, queued messages are replayed in order.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface QueuedMessage {
  id: string;
  topicId: number;
  text: string;
  fromUserId: number;
  fromUsername?: string;
  fromFirstName: string;
  timestamp: string;
  voiceFile?: string;
  photoPath?: string;
  documentPath?: string;
  documentName?: string;
  /** Number of times this message has been replayed and failed to deliver. */
  replayFailures?: number;
}

export class MessageQueue {
  private queuePath: string;
  private queue: QueuedMessage[] = [];

  constructor(stateDir: string) {
    this.queuePath = path.join(stateDir, 'lifeline-queue.json');
    this.load();
  }

  /**
   * Add a message to the queue.
   */
  enqueue(msg: QueuedMessage): void {
    this.queue.push(msg);
    this.save();
  }

  /**
   * Get all queued messages and clear the queue.
   */
  drain(): QueuedMessage[] {
    const messages = [...this.queue];
    this.queue = [];
    this.save();
    return messages;
  }

  /**
   * Peek at the queue without draining.
   */
  peek(): QueuedMessage[] {
    return [...this.queue];
  }

  get length(): number {
    return this.queue.length;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.queuePath)) {
        const data = JSON.parse(fs.readFileSync(this.queuePath, 'utf-8'));
        this.queue = Array.isArray(data) ? data : [];
      }
    } catch {
      this.queue = [];
    }
  }

  private save(): void {
    try {
      const tmpPath = `${this.queuePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.queue, null, 2));
      fs.renameSync(tmpPath, this.queuePath);
    } catch (err) {
      console.error(`[MessageQueue] Failed to save: ${err}`);
    }
  }
}
