<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		X,
		Reply,
		Send,
		CodeXml,
		ChevronDown,
		ChevronRight,
		Paperclip,
		LoaderCircle
	} from 'lucide-svelte';
	import { USER_DATA } from '$lib/stores/user';
	import type { AllowedCSSProperty, Email, EmailContentType } from '$lib/types/email';
	import {
		ALLOWED_HTML_TAGS,
		ALLOWED_HTML_ATTRIBUTES,
		ALLOWED_CSS_PROPERTIES
	} from '$lib/types/email';
	import DOMPurify from 'dompurify';
	import type { Config } from 'dompurify';
	import { mode } from 'mode-watcher';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { PUBLIC_DOMAIN, PUBLIC_TURNSTILE_SITE_KEY } from '$env/static/public';
	import { getInitials, getRandomColor } from '$lib/utils';
	import Attachment from './Attachment.svelte';
	import ImagePreview from './ImagePreview.svelte';
	import FileAttachment from './FileAttachment.svelte';
	import { IMAGE_TYPES, MAX_FILES, type ImageType } from '$lib/types/attachment';
	import { toast } from 'svelte-sonner';
	import { HashcashPool } from '$lib/hashcash';
	import { onDestroy } from 'svelte';
	import log from '$lib/logger';
	import { debounce, checkVocabulary } from '$lib/utils';
	import { proxyUrl } from '$lib/utils/proxyUrl';
	import { formatThreadDate } from '$lib/utils/format-date';
	import { Turnstile } from 'svelte-turnstile';

	function isImageAttachment(type: string): boolean {
		return IMAGE_TYPES.includes(type as ImageType);
	}

	let { email, onClose } = $props<{
		email: Email | null;
		onClose: () => void;
	}>();

	let isReplying = $state(false);
	let replyText = $state('');
	let htmlMode = $state(false);
	let threadEmails = $state<Email[]>([]);
	let expandedEmails = $state(new Set<string>());
	let replyRecipient = $state('');
	let attachments = $state<
		Array<{
			id: string;
			filename: string;
			size: number;
			type: string;
		}>
	>([]);

	let attachmentComponent: Attachment | null = $state(null);
	let isSending = $state(false);
	let vocabularyError = $state('');
	let turnstileToken = $state('');
	let turnstileReset = $state<() => void>();

	const sanitizeConfig: Config = {
		ALLOWED_TAGS: [...ALLOWED_HTML_TAGS],
		ALLOWED_ATTR: ['href', 'src', 'alt', 'style'],
		ALLOWED_URI_REGEXP:
			/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
	};

	const themePlaceholderRegex = /\{\s*\$LIGHT\s*\?\s*([^:]+?)\s*:\s*([^}]+?)\s*\}/g;

	function processThemeStyles(html: string, currentMode: 'light' | 'dark'): string {
		const result = html.replace(themePlaceholderRegex, (match, lightValue, darkValue) => {
			const replacement = currentMode === 'light' ? lightValue.trim() : darkValue.trim();
			return replacement;
		});
		return result;
	}

	function getSanitizedContent(email: Email | null, currentMode: 'light' | 'dark'): string {
		if (!email) return '';
		if (email.content_type === 'text/html' && email.html_body) {
			const processedHtml = processThemeStyles(email.html_body, currentMode);

			DOMPurify.addHook('afterSanitizeAttributes', (node) => {
				if (node.tagName === 'IMG') {
					const originalSrc = node.getAttribute('src');
					if (originalSrc) {
						node.setAttribute('src', proxyUrl(originalSrc));
					}
				}
			});

			const sanitized = DOMPurify.sanitize(processedHtml, sanitizeConfig);

			DOMPurify.removeHook('afterSanitizeAttributes');

			return sanitized;
		}
		return email.body || '';
	}

	async function markAsRead(emailId: string) {
		try {
			await fetch('/api/emails/read', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ emailId })
			});
		} catch (error) {
			console.error('Failed to mark email as read:', error);
		}
	}

	async function loadThreadEmails(email: Email) {
		if (!email.thread_id && !email.id) return;

		try {
			const response = await fetch(`/api/emails/thread?id=${email.thread_id || email.id}`);
			if (response.ok) {
				const { emails } = await response.json();
				const sortedEmails = emails.sort(
					(a: Email, b: Email) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()
				);
				threadEmails = sortedEmails;

				// FETCH IQ
				const uniqueAddresses = new Set(sortedEmails.map((e: Email) => e.from_address));
				const newIQs = new Map<string, number | null>();

				await Promise.all(
					Array.from(uniqueAddresses as Set<string>).map(async (address: string) => {
						const iq = await getUserIQ(address);
						newIQs.set(address, iq);
					})
				);

				emailIQs = newIQs;

				// END FETCH IQ

				const initialEmailIndex = sortedEmails.findIndex((e: Email) => e.id === email.id);

				const newExpandedSet = new Set<string>();
				if (initialEmailIndex !== -1) {
					for (let i = initialEmailIndex; i < sortedEmails.length; i++) {
						newExpandedSet.add(sortedEmails[i].id);
					}
				} else {
					if (email) {
						newExpandedSet.add(email.id);
					}
					if (sortedEmails.length > 0) {
						newExpandedSet.add(sortedEmails[sortedEmails.length - 1].id);
					}
				}
				expandedEmails = newExpandedSet;
			}
		} catch (error) {
			console.error('Failed to load thread:', error);
		}
	}

	function handleReplyClick() {
		if (!email || !$USER_DATA) return;

		const currentUserEmail = `${$USER_DATA.username}#${PUBLIC_DOMAIN}`;

		if (email.from_address === currentUserEmail) {
			replyRecipient = email.to_address;
		} else {
			replyRecipient = email.from_address;
		}

		if (!replyRecipient || !replyRecipient.includes('#')) {
			console.error('Could not determine a valid recipient for the reply.', email);
			return;
		}

		isReplying = true;
	}

	const debouncedCheckReplyVocabulary = debounce(async () => {
		if (htmlMode) {
			vocabularyError = '';
			return;
		}

		const userIQ = $USER_DATA?.iq ?? 100;
		if (replyText) {
			const { isValid, limit } = checkVocabulary(replyText, userIQ);
			if (!isValid) {
				vocabularyError = `Word length exceeds limit (${limit}) for IQ ${userIQ}.`;
			} else {
				vocabularyError = '';
			}
		} else {
			vocabularyError = '';
		}
	}, 500);

	$effect(() => {
		if (isReplying && replyText) {
			debouncedCheckReplyVocabulary();
		} else {
			vocabularyError = '';
		}
	});

	async function handleSendReply() {
		if (!replyText.trim() || !email || !replyRecipient || !$USER_DATA || isSending) return;

		vocabularyError = '';
		isSending = true;
		const sendToastId = toast.loading('Verifying your message...');

		if (!turnstileToken) {
			toast.loading('Completing security check...', { id: sendToastId });

			try {
				await new Promise((resolve, reject) => {
					const timeout = setTimeout(() => reject(new Error('Verification timeout')), 30000);
					const checkToken = setInterval(() => {
						if (turnstileToken) {
							clearTimeout(timeout);
							clearInterval(checkToken);
							resolve(true);
						}
					}, 100);
				});
			} catch (error) {
				toast.error('Security check failed, please try again', { id: sendToastId });
				isSending = false;
				return;
			}
		}

		try {
			let finalAttachments: Array<{ key: string; filename: string; size: number; type: string }> =
				[];

			if (attachmentComponent && attachments.length > 0) {
				toast.loading('Uploading attachments...', { id: sendToastId });
				try {
					finalAttachments = await attachmentComponent.uploadAllFiles();
					toast.success('Attachments uploaded.', { id: sendToastId });
				} catch (uploadError) {
					console.error('Attachment upload failed:', uploadError);
					toast.error('Failed to upload attachments. Please try again.', { id: sendToastId });
					isSending = false;
					return;
				}
			} else {
				toast.loading('Sending email...', { id: sendToastId });
			}

			toast.loading('Computing SHARP requirements...', { id: sendToastId });
			const hashcash = await hashcashPool.getToken(replyRecipient);
			toast.loading('Sending email...', { id: sendToastId });

			const currentUserEmail = `${$USER_DATA.username}#${PUBLIC_DOMAIN}`;

			const emailData = {
				from: currentUserEmail,
				to: replyRecipient,
				subject: `Re: ${email.subject?.replace(/^Re:\s+/i, '')}` || '',
				body: replyText,
				content_type: htmlMode ? 'text/html' : 'text/plain',
				html_body: htmlMode ? replyText : null,
				reply_to_id: email.id,
				thread_id: email.thread_id || email.id,
				attachments: finalAttachments,
				hashcash,
				turnstileToken
			};

			const response = await fetch('/api/emails/new', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(emailData)
			});

			if (response.ok) {
				const { status, result } = await response.json();

				if (status !== 'success' || !result?.success) {
					throw new Error(`API Error: ${status} - ${JSON.stringify(result)}`);
				}

				const tempId = crypto.randomUUID();
				const newEmail: Email = {
					id: tempId,
					from_address: emailData.from,
					to_address: emailData.to,
					from_domain: emailData.from.split('#')[1] || '',
					to_domain: emailData.to.split('#')[1] || '',
					subject: emailData.subject,
					body: emailData.body,
					html_body: emailData.html_body,
					content_type: emailData.content_type as EmailContentType,
					sent_at: new Date().toISOString(),
					thread_id: emailData.thread_id,
					reply_to_id: emailData.reply_to_id,
					read_at: new Date().toISOString(),
					starred: false,
					classification: 'primary',
					status: 'sent',
					error_message: null,
					attachments: emailData.attachments,
					expires_at: null,
					self_destruct: false
				};

				threadEmails = [...threadEmails, newEmail];
				expandedEmails = new Set([...expandedEmails, tempId]);
				isReplying = false;
				replyText = '';
				attachments = [];

				toast.success('Email sent successfully!', { id: sendToastId });
				await loadThreadEmails(email);
			} else {
				const errorData = await response.json();

				if (response.status === 429 && errorData.retryWithHigherDifficulty && !isRetrying) {
					log.warn(`Received 429: ${errorData.message}. Retrying...`);
					toast.loading('Taking an extra moment to verify your email...', { id: sendToastId });
					isRetrying = true;

					throw new Error(`Proof of work insufficient. Please try sending again.`);
				}
				isRetrying = false;
				throw new Error(`API Error ${response.status}: ${JSON.stringify(errorData)}`);
			}
		} catch (error) {
			console.error('Error sending reply:', error);
			toast.error(
				`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`,
				{
					id: sendToastId
				}
			);
		} finally {
			isSending = false;
		}
	}

	function toggleExpanded(emailId: string) {
		const newSet = new Set(expandedEmails);
		if (newSet.has(emailId)) {
			newSet.delete(emailId);
		} else {
			newSet.add(emailId);
		}
		expandedEmails = newSet;
	}

	$effect(() => {
		DOMPurify.removeHook('uponSanitizeElement');
		DOMPurify.removeHook('uponSanitizeAttribute');

		if (email?.content_type === 'text/html') {
			(DOMPurify as any).addHook(
				'uponSanitizeElement',
				(node: Element, data: { tagName: string }) => {
					const tagName = data.tagName.toLowerCase() as keyof typeof ALLOWED_HTML_ATTRIBUTES;
					const specificAttrsForTag = ALLOWED_HTML_ATTRIBUTES[tagName];
					const wildcardAttrs = ALLOWED_HTML_ATTRIBUTES['*'] || [];

					let effectiveAllowedAttrs: readonly string[];

					if (specificAttrsForTag) {
						const combined = new Set([...specificAttrsForTag, ...wildcardAttrs]);
						effectiveAllowedAttrs = Array.from(combined);
					} else {
						effectiveAllowedAttrs = wildcardAttrs;
					}

					if (node.attributes) {
						Array.from(node.attributes).forEach((attr) => {
							if (!effectiveAllowedAttrs.includes(attr.name)) {
								node.removeAttribute(attr.name);
							}
						});
					}
				}
			);

			(DOMPurify as any).addHook(
				'uponSanitizeAttribute',
				(node: Element, data: { attrName: string; attrValue: string }) => {
					if (data.attrName === 'style') {
						const parts = data.attrValue.split(';');
						const out: string[] = [];
						for (const part of parts) {
							const [rawProp, ...rawVal] = part.split(':');
							if (!rawProp || rawVal.length === 0) continue;
							const prop = rawProp.trim();
							let value = rawVal.join(':').trim();
							if (prop && ALLOWED_CSS_PROPERTIES.includes(prop as AllowedCSSProperty)) {
								if (
									(value.startsWith('"') && value.endsWith('"')) ||
									(value.startsWith("'") && value.endsWith("'"))
								) {
									value = value.slice(1, -1).trim();
								}
								if (prop === 'border' || prop.startsWith('border-')) {
									value = value.replace(/(\d+)(px|em|rem|%|vh|vw)/g, (_m, num) => {
										const n = Math.min(Math.max(0, parseInt(num, 10)), 20);
										return `${n}px`;
									});
								}
								out.push(`${prop}: ${value}`);
							}
						}
						data.attrValue = out.join('; ');
					}
				}
			);
		}

		if (email && !$USER_DATA) {
			console.warn('Email prop updated but USER_DATA is not available yet.');
		}

		if (email && $USER_DATA) {
			const currentUserEmail = `${$USER_DATA.username}#${PUBLIC_DOMAIN}`;
			if (email.to_address === currentUserEmail && !email.read_at) {
				markAsRead(email.id);
			}
			loadThreadEmails(email);
		}

		isReplying = false;
		replyRecipient = '';
		replyText = '';
	});

	function handleFilesChange(
		files: Array<{ id: string; filename: string; size: number; type: string }>
	) {
		attachments = files;
	}

	async function getUserIQ(emailAddress: string): Promise<number | null> {
		try {
			const response = await fetch(`/api/users/${encodeURIComponent(emailAddress)}/iq`);
			if (response.ok) {
				const data = await response.json();
				return data.iq;
			}
		} catch (error) {
			console.error('Failed to fetch user IQ:', error);
		}
		return null;
	}

	let emailIQs = $state(new Map<string, number | null>());

	const hashcashPool = new HashcashPool();
	let serverConfig = $state<{ hashcash: { minBits: number; recommendedBits: number } } | null>(
		null
	);
	let isRetrying = $state(false);

	async function fetchServerConfig() {
		try {
			const response = await fetch(`https://${PUBLIC_DOMAIN}/sharp/api/server/health`);
			if (response.ok) {
				serverConfig = await response.json();
				if (serverConfig?.hashcash?.recommendedBits) {
					hashcashPool.setMinBits(serverConfig.hashcash.recommendedBits);
				}
			}
		} catch (error) {
			console.error('Failed to fetch server config:', error);
		}
	}

	$effect(() => {
		fetchServerConfig();
	});

	$effect(() => {
		if (replyRecipient && replyRecipient.includes('#')) {
			log.debug(`Reply recipient set to ${replyRecipient}, ensuring pool is filled.`);
			hashcashPool.ensurePoolFilled(replyRecipient);
		}
	});

	onDestroy(() => {
		hashcashPool.cleanup();
	});

	function onTurnstileVerified(e: CustomEvent<{ token: string }>) {
		turnstileToken = e.detail.token;
	}
</script>

<Turnstile
	siteKey={PUBLIC_TURNSTILE_SITE_KEY}
	theme={mode.current}
	size="invisible"
	on:callback={onTurnstileVerified}
	bind:reset={turnstileReset}
/>

{#if email}
	<div class="flex h-full flex-col md:relative">
		<!-- Original header -->
		<div class="border-b p-2 md:p-4">
			<Button variant="ghost" size="icon" class="float-right" onclick={onClose}>
				<X class="h-4 w-4" />
			</Button>
			<h2 class="line-clamp-1 text-lg font-semibold md:text-xl">{email.subject || 'No subject'}</h2>
		</div>

		<!-- THREAD LIST -->
		<div class="flex-1 divide-y overflow-auto">
			{#each threadEmails as threadEmail (threadEmail.id)}
				<div class="p-2 md:p-4">
					<button
						type="button"
						class="flex cursor-pointer items-center gap-2"
						onclick={() => toggleExpanded(threadEmail.id)}
						aria-expanded={expandedEmails.has(threadEmail.id)}
					>
						{#if expandedEmails.has(threadEmail.id)}
							<ChevronDown class="h-4 w-4" />
						{:else}
							<ChevronRight class="h-4 w-4" />
						{/if}
						<div class="flex flex-1 items-center justify-between">
							<div class="flex items-center gap-2">
								<div
									class={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${getRandomColor(
										threadEmail.from_address
									)}`}
								>
									<span class="text-xs font-medium">
										{getInitials(
											threadEmail.from_address.split('#')[0].includes('.')
												? threadEmail.from_address.split('#')[0].split('.').join(' ')
												: threadEmail.from_address.split('#')[0]
										)}</span
									>
								</div>
								<span class="font-medium">{threadEmail.from_address}</span>
								{#if emailIQs.has(threadEmail.from_address) && emailIQs.get(threadEmail.from_address) !== null}
									<span class="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs font-medium">
										{emailIQs.get(threadEmail.from_address)} IQ
									</span>
								{/if}
								<span class="text-muted-foreground text-sm">
									{formatThreadDate(threadEmail.sent_at)}
								</span>
							</div>
						</div>
					</button>

					{#if expandedEmails.has(threadEmail.id)}
						<div class="mt-2 pl-2 md:mt-4 md:pl-6">
							{#if threadEmail.content_type === 'text/html'}
								{@html getSanitizedContent(threadEmail, mode.current ?? 'light')}
							{:else}
								<div class="whitespace-pre-wrap">{threadEmail.body || ''}</div>
							{/if}

							{#if threadEmail.attachments?.length}
								<div class="mt-2 space-y-2 md:mt-4 md:space-y-3">
									{#if threadEmail.attachments.some((a) => isImageAttachment(a.type))}
										<div
											class="grid grid-cols-[repeat(auto-fill,120px)] gap-2 md:grid-cols-[repeat(auto-fill,160px)] md:gap-3"
										>
											{#each threadEmail.attachments.filter( (a) => isImageAttachment(a.type) ) as attachment}
												<div class="relative aspect-square h-[120px] md:h-[160px]">
													<ImagePreview
														url={`/api/attachment?key=${attachment.key}`}
														filename={attachment.filename}
														filesize={attachment.size}
													/>
												</div>
											{/each}
										</div>
									{/if}

									{#if threadEmail.attachments.some((a) => !isImageAttachment(a.type))}
										<div class="flex flex-wrap gap-3">
											{#each threadEmail.attachments.filter((a) => !isImageAttachment(a.type)) as attachment}
												<a
													href={`/api/attachment?key=${attachment.key}`}
													target="_blank"
													rel="noopener noreferrer"
													class="w-auto max-w-[240px]"
												>
													<FileAttachment
														filename={attachment.filename}
														filesize={attachment.size}
														showDownload={true}
													/>
												</a>
											{/each}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- REPLY BOX AT BOTTOM -->
		<div class="border-t p-2 md:p-4">
			{#if isReplying}
				<div class="flex flex-col gap-2 md:gap-4">
					<div
						class="border-input/50 focus-within:border-primary flex flex-col rounded-lg border-2"
					>
						<textarea
							bind:value={replyText}
							id="reply-textarea"
							class="bg-background placeholder:text-muted-foreground min-h-[100px] w-full resize-none rounded-t-lg px-2 py-2 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:min-h-[120px] md:px-3.5 md:py-3 md:text-base"
							placeholder="Write your reply..."
							disabled={isSending}
						></textarea>

						<div
							class="bg-muted/50 border-input/50 flex items-center gap-2 rounded-b-lg border-t-2 p-2"
						>
							<Button
								size="sm"
								class="transition-colors"
								onclick={handleSendReply}
								disabled={!replyText.trim() || isSending || !!vocabularyError}
							>
								{#if isSending}
									<LoaderCircle class="h-4 w-4 animate-spin" />
									Sending...
								{:else}
									<Send class="h-4 w-4" />
									Send
								{/if}
							</Button>

							<div class="flex items-center gap-2">
								<Tooltip.Root>
									<Tooltip.Trigger>
										<button
											class="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors {htmlMode
												? 'bg-primary/10 text-primary'
												: 'text-muted-foreground hover:bg-muted'}"
											onclick={() => (htmlMode = !htmlMode)}
										>
											<CodeXml class="h-4 w-4" />
											<span class="sr-only">HTML Mode</span>
										</button>
									</Tooltip.Trigger>
									<Tooltip.Content side="bottom">HTML Mode</Tooltip.Content>
								</Tooltip.Root>

								<Tooltip.Root>
									<Tooltip.Trigger>
										<button
											class="text-muted-foreground hover:bg-muted relative flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
											onclick={() => attachmentComponent?.openFileSelect()}
											disabled={attachments.length >= MAX_FILES || isSending}
										>
											<Paperclip class="h-4 w-4" />
											{#if attachments.length > 0}
												<span
													class="bg-primary text-secondary-foreground absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px]"
												>
													{attachments.length}
												</span>
											{/if}
											<span class="sr-only">Attach files ({attachments.length}/{MAX_FILES})</span>
										</button>
									</Tooltip.Trigger>
									<Tooltip.Content side="bottom"
										>Attach files ({attachments.length}/{MAX_FILES})</Tooltip.Content
									>
								</Tooltip.Root>

								{#if vocabularyError}
									<p class="text-destructive text-xs">{vocabularyError}</p>
								{/if}
							</div>
						</div>
					</div>
					<Attachment bind:this={attachmentComponent} onFilesChange={handleFilesChange} />
				</div>
			{:else}
				<Button
					class="hover:border-input hover:bg-muted/20 w-full transition-colors"
					size="lg"
					variant="outline"
					onclick={handleReplyClick}
					disabled={email?.self_destruct}
					title={email?.self_destruct ? 'Cannot reply to self-destructing emails' : ''}
				>
					<Reply class="h-5 w-5" />
					{email?.self_destruct ? 'Cannot reply to this email' : 'Reply to this conversation'}
				</Button>
			{/if}
		</div>
	</div>
{:else}
	<div class="text-muted-foreground flex h-full items-center justify-center p-4 text-center">
		Select an email to view its contents
	</div>
{/if}

<style lang="postcss">
	:global(.badge-row) {
		@apply text-muted-foreground flex flex-wrap items-center gap-2 text-sm;
	}

	:global(.prose table) {
		width: 100%;
		border-collapse: collapse;
		margin: 1rem 0;
	}

	:global(.prose th),
	:global(.prose td) {
		border: 1px solid hsl(var(--border));
		padding: 0.75rem;
	}

	:global(.prose th) {
		background-color: hsl(var(--muted));
		font-weight: 600;
	}

	/* List styles */
	:global(.prose ul) {
		list-style-type: disc;
		padding-left: 1.5rem;
		margin: 1rem 0;
	}

	:global(.prose ol) {
		list-style-type: decimal;
		padding-left: 1.5rem;
		margin: 1rem 0;
	}

	/* Link styles */
	:global(.prose a) {
		color: hsl(var(--primary));
		text-decoration: underline;
	}

	:global(.prose a:hover) {
		color: hsl(var(--primary) / 0.8);
	}
</style>
