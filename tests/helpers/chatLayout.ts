import type { Page } from '@playwright/test';

export async function settleChatLayout(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    let previous = '';
    let stable = 0;
    let frames = 0;
    const sample = () => {
      const chat = document.querySelector<HTMLElement>('.chatContainer');
      const geometry = chat ? [chat.clientWidth, chat.clientHeight, chat.scrollHeight, chat.scrollTop].join(',') : '';
      stable = geometry && geometry === previous ? stable + 1 : 0;
      previous = geometry;
      if (stable >= 4) resolve();
      else if (++frames >= 120) reject(new Error('Chat layout did not settle'));
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}
