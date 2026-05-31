import { AzureOpenAI } from 'openai';
import { config } from '../config';

const client = new AzureOpenAI({
  endpoint: config.azureOpenai.endpoint,
  apiKey: config.azureOpenai.apiKey,
  apiVersion: config.azureOpenai.apiVersion,
});

/**
 * 呼叫 Azure OpenAI 生成回答
 * 目前使用 gpt-4.1，未來可換回 Claude
 */
export async function askClaude(
  question: string,
  context: string,
): Promise<string> {
  const systemPrompt = config.rag.systemPrompt.replace('{context}', context);

  const response = await client.chat.completions.create({
    model: config.chatModel,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
  });

  return response.choices[0]?.message?.content || '抱歉，無法生成回答。';
}
