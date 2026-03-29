import {
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { promptQuietForLoudResponse } from '../../../slash-commands.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { registerSlashCommand } from '../../../slash-commands.js';

const extensionName = 'third-party/Extension-Idle';

let idleTimer = null;
let repeatCount = 0;

let defaultSettings = {
    enabled: false,
    timer: 120,
    prompts: [
        '*stands silently, looking deep in thought*',
        '*pauses, eyes wandering over the surroundings*',
        '*hesitates, appearing lost for a moment*',
        '*takes a deep breath, collecting their thoughts*',
        '*gazes into the distance, seemingly distracted*',
        '*remains still, absorbing the ambiance*',
        '*lingers in silence, a contemplative look on their face*',
        '*stops, fingers brushing against an old memory*',
        '*seems to drift into a momentary daydream*',
        '*waits quietly, allowing the weight of the moment to settle*',
    ],
    useContinuation: true,
    useRegenerate: false,
    useImpersonation: false,
    useSwipe: false,
    repeats: 2, // 0 = infinite
    randomTime: false,
    timeMin: 60,
    includePrompt: false,
    // Discord webhook settings
    discordWebhookEnabled: false,
    discordWebhookUrl: '',
    // Reminder macro template
    reminderPrompt: '[You set a reminder earlier: "{{reminder}}". It was set at {{reminder_time}}. Remind the user now.]',
    // Persisted reminders array: [{ message, setAt, fireAt }]
    reminders: [],
};


//TODO: Can we make this a generic function?
/**
 * Load the extension settings and set defaults if they don't exist.
 */
async function loadSettings() {
    if (!extension_settings.idle) {
        console.log('Creating extension_settings.idle');
        extension_settings.idle = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extension_settings.idle.hasOwnProperty(key)) {
            console.log(`Setting default for: ${key}`);
            extension_settings.idle[key] = value;
        }
    }
    populateUIWithSettings();
}

//TODO: Can we make this a generic function too?
/**
 * Populate the UI components with values from the extension settings.
 */
function populateUIWithSettings() {
    $('#idle_timer').val(extension_settings.idle.timer).trigger('input');
    $('#idle_prompts').val(extension_settings.idle.prompts.join('\n')).trigger('input');
    $('#idle_use_continuation').prop('checked', extension_settings.idle.useContinuation).trigger('input');
    $('#idle_use_regenerate').prop('checked', extension_settings.idle.useRegenerate).trigger('input');
    $('#idle_use_impersonation').prop('checked', extension_settings.idle.useImpersonation).trigger('input');
    $('#idle_use_swipe').prop('checked', extension_settings.idle.useSwipe).trigger('input');
    $('#idle_enabled').prop('checked', extension_settings.idle.enabled).trigger('input');
    $('#idle_repeats').val(extension_settings.idle.repeats).trigger('input');
    $('#idle_random_time').prop('checked', extension_settings.idle.randomTime).trigger('input');
    $('#idle_timer_min').val(extension_settings.idle.timerMin).trigger('input');
    $('#idle_include_prompt').prop('checked', extension_settings.idle.includePrompt).trigger('input');
    // Discord webhook UI
    $('#idle_discord_webhook_enabled').prop('checked', extension_settings.idle.discordWebhookEnabled).trigger('input');
    $('#idle_discord_webhook_url').val(extension_settings.idle.discordWebhookUrl).trigger('input');
    // Reminder UI
    $('#idle_reminder_prompt').val(extension_settings.idle.reminderPrompt).trigger('input');
    renderRemindersList();
}


/**
 * Reset the idle timer based on the extension settings and context.
 * Does nothing if a /reply-in is pending.
 */
function resetIdleTimer() {
    if (replyInPending) {
        console.debug('Idle: skipping resetIdleTimer — /reply-in pending');
        return;
    }
    console.debug('Resetting idle timer');
    if (idleTimer) clearTimeout(idleTimer);
    let context = getContext();
    if (!context.characterId && !context.groupID) return;
    if (!extension_settings.idle.enabled) return;
    if (extension_settings.idle.randomTime) {
        let min = parseInt(extension_settings.idle.timerMin);
        let max = parseInt(extension_settings.idle.timer);
        let randomTime = (Math.random() * (max - min + 1)) + min;
        idleTimer = setTimeout(sendIdlePrompt, 1000 * randomTime);
    } else {
        idleTimer = setTimeout(sendIdlePrompt, 1000 * extension_settings.idle.timer);
    }
}

// True while a /reply-in timer is pending — suppresses normal idle firing
let replyInPending = false;
let reminderHeartbeat = null;

// ─── Duration parsing ────────────────────────────────────────────────────────

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: "10 minutes", "90 seconds", "2 hours", "1 day",
 *           compound forms: "2 hours 30 minutes", "1 day 12 hours", etc.
 * @param {string} str
 * @returns {number|null} milliseconds, or null if unparseable
 */
function parseDuration(str) {
    const units = {
        second: 1000, seconds: 1000, sec: 1000, secs: 1000, s: 1000,
        minute: 60000, minutes: 60000, min: 60000, mins: 60000, m: 60000,
        hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000, h: 3600000,
        day: 86400000, days: 86400000, d: 86400000,
    };
    const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;
    let total = 0;
    let matched = false;
    let m;
    while ((m = re.exec(str)) !== null) {
        const val = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        const factor = units[unit];
        if (factor) { total += val * factor; matched = true; }
    }
    return matched ? total : null;
}

// ─── /reply-in ───────────────────────────────────────────────────────────────

/**
 * Handle a /reply-in command found in a character message.
 * Disables normal idle while pending, fires a single sendIdlePrompt after delay.
 * @param {string} durationStr  e.g. "10 minutes"
 */
function handleReplyIn(durationStr) {
    const ms = parseDuration(durationStr);
    if (!ms || ms <= 0) {
        console.warn(`Idle: could not parse /reply-in duration: "${durationStr}"`);
        return;
    }

    console.debug(`Idle: /reply-in scheduled in ${ms}ms`);
    clearTimeout(idleTimer);
    replyInPending = true;

    idleTimer = setTimeout(async () => {
        replyInPending = false;
        repeatCount = 0; // treat as fresh interaction
        await sendIdlePrompt();
    }, ms);
}

// ─── /set-self-reminder ──────────────────────────────────────────────────────

/**
 * Parse a date + time string into a timestamp.
 * Accepts "M/D/YYYY" or "YYYY-MM-DD" dates and "H:MMam/pm" or "HH:MM" times.
 * @param {string} dateStr
 * @param {string} timeStr
 * @returns {number|null} unix timestamp ms, or null on failure
 */
function parseReminderDateTime(dateStr, timeStr) {
    try {
        // Normalise date separators
        const normDate = dateStr.trim().replace(/-/g, '/');
        const combined = `${normDate} ${timeStr.trim()}`;
        const ts = Date.parse(combined);
        if (!isNaN(ts)) return ts;

        // Fallback: try just the date part (midnight)
        const tsDate = Date.parse(normDate);
        return isNaN(tsDate) ? null : tsDate;
    } catch {
        return null;
    }
}

/**
 * Store a new reminder in settings.
 * @param {string} message
 * @param {string} dateStr
 * @param {string} timeStr
 */
function handleSetSelfReminder(message, dateStr, timeStr) {
    const fireAt = parseReminderDateTime(dateStr, timeStr);
    if (!fireAt) {
        console.warn(`Idle: could not parse reminder date/time: "${dateStr}" "${timeStr}"`);
        return;
    }

    const reminder = {
        message,
        setAt: new Date().toLocaleString(),
        fireAt,
    };

    if (!Array.isArray(extension_settings.idle.reminders)) {
        extension_settings.idle.reminders = [];
    }
    extension_settings.idle.reminders.push(reminder);
    saveSettingsDebounced();
    renderRemindersList();
    console.debug(`Idle: reminder set for ${new Date(fireAt).toLocaleString()} — "${message}"`);
}

/**
 * Fire a due reminder as a user prompt using the configured reminderPrompt template.
 * @param {{ message: string, setAt: string, fireAt: number }} reminder
 */
function fireReminder(reminder) {
    const template = extension_settings.idle.reminderPrompt ||
        '[You set a reminder earlier: "{{reminder}}". It was set at {{reminder_time}}. Remind the user now.]';

    const prompt = template
        .replace(/{{reminder}}/g, reminder.message)
        .replace(/{{reminder_time}}/g, reminder.setAt);

    console.debug(`Idle: firing reminder — "${reminder.message}"`);
    sendPrompt(prompt);
}

/**
 * Check all pending reminders and fire any that are due.
 * Called on a 30-second heartbeat.
 */
function checkReminders() {
    if (!Array.isArray(extension_settings.idle.reminders)) return;

    const now = Date.now();
    const pending = [];
    let changed = false;

    for (const r of extension_settings.idle.reminders) {
        if (r.fireAt <= now) {
            fireReminder(r);
            changed = true;
        } else {
            pending.push(r);
        }
    }

    if (changed) {
        extension_settings.idle.reminders = pending;
        saveSettingsDebounced();
        renderRemindersList();
    }
}

/**
 * Start the 30-second reminder heartbeat. Safe to call multiple times.
 */
function startReminderHeartbeat() {
    if (reminderHeartbeat) return;
    reminderHeartbeat = setInterval(checkReminders, 30000);
    // Also check immediately in case reminders fired while ST was closed
    checkReminders();
}

/**
 * Refresh the pending reminders list shown in the settings UI.
 */
function renderRemindersList() {
    const $list = $('#idle_reminders_list');
    if (!$list.length) return;
    const reminders = extension_settings.idle.reminders || [];
    if (!reminders.length) {
        $list.html('<em style="opacity:0.5;">No pending reminders.</em>');
        return;
    }
    const items = reminders.map((r, i) => {
        const when = new Date(r.fireAt).toLocaleString();
        return `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
            <span>⏰ <b>${when}</b> — ${r.message}</span>
            <button class="idle_delete_reminder menu_button" data-index="${i}" style="padding:1px 7px; font-size:0.8em;">✕</button>
        </div>`;
    }).join('');
    $list.html(items);

    $list.find('.idle_delete_reminder').on('click', function () {
        const idx = parseInt($(this).data('index'));
        extension_settings.idle.reminders.splice(idx, 1);
        saveSettingsDebounced();
        renderRemindersList();
    });
}

/**
 * Scan a character message for known commands and dispatch them.
 * Commands are matched anywhere in the text.
 *
 * Supported:
 *   /reply-in "duration"
 *   /set-self-reminder "message" "date" "time"
 *
 * @param {string} text  Raw text of the character's message.
 */
function processCharacterCommands(text) {
    // /reply-in "10 minutes"
    const replyInRe = /\/reply-in\s+"([^"]+)"/i;
    const replyInMatch = text.match(replyInRe);
    if (replyInMatch) {
        handleReplyIn(replyInMatch[1]);
    }

    // /set-self-reminder "message" "date" "time"
    const reminderRe = /\/set-self-reminder\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/i;
    const reminderMatch = text.match(reminderRe);
    if (reminderMatch) {
        handleSetSelfReminder(reminderMatch[1], reminderMatch[2], reminderMatch[3]);
    }
}


 * @param {string} characterName - The name of the character sending the message.
 * @param {string} messageContent - The content of the idle message.
 */
async function sendDiscordWebhook(characterName, messageContent) {
    if (!extension_settings.idle.discordWebhookEnabled) return;

    const webhookUrl = extension_settings.idle.discordWebhookUrl?.trim();
    if (!webhookUrl) {
        console.warn('Discord webhook is enabled but no URL is set.');
        return;
    }

    const payload = {
        username: characterName || 'SillyTavern Idle',
        content: `💬 **${characterName}** sent an idle message:`,
        embeds: [
            {
                description: messageContent,
                color: 0x5865F2, // Discord blurple
                footer: {
                    text: 'SillyTavern • Idle Extension',
                },
                timestamp: new Date().toISOString(),
            },
        ],
    };

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`Discord webhook failed: ${response.status} ${response.statusText}`);
        } else {
            console.debug('Discord webhook sent successfully.');
        }
    } catch (error) {
        console.error('Error sending Discord webhook:', error);
    }
}

/**
 * Wait for the AI to finish generating, then return the last character message text.
 * First waits for #mes_stop to become visible (generation started),
 * then waits for it to hide (generation finished), then reads the last char message.
 * @param {number} [timeoutMs=60000] - Max time to wait before giving up.
 * @returns {Promise<string>} The character's response text, or empty string on timeout.
 */
function waitForCharacterResponse(timeoutMs = 60000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const elapsed = () => Date.now() - start;

        // Phase 1: wait for generation to START (#mes_stop becomes visible)
        function waitForStart() {
            if (elapsed() > timeoutMs) { resolve(''); return; }
            if ($('#mes_stop').is(':visible')) {
                waitForEnd();
            } else {
                setTimeout(waitForStart, 100);
            }
        }

        // Phase 2: wait for generation to END (#mes_stop becomes hidden)
        function waitForEnd() {
            if (elapsed() > timeoutMs) { resolve(''); return; }
            if (!$('#mes_stop').is(':visible')) {
                // Generation done — read the last character message
                const text = $('.mes[is_user="false"]').last().find('.mes_text').text().trim();
                resolve(text);
            } else {
                setTimeout(waitForEnd, 300);
            }
        }

        waitForStart();
    });
}

/**
 * Send a random idle prompt to the AI based on the extension settings.
 * Checks conditions like if the extension is enabled and repeat conditions.
 */
async function sendIdlePrompt() {
    if (!extension_settings.idle.enabled) return;

    // Check repeat conditions and waiting for a response
    if (repeatCount >= extension_settings.idle.repeats || $('#mes_stop').is(':visible')) {
        resetIdleTimer();
        return;
    }

    const randomPrompt = extension_settings.idle.prompts[
        Math.floor(Math.random() * extension_settings.idle.prompts.length)
    ];

    const context = getContext();
    const characterName = context.name2 || 'Character';

    sendPrompt(randomPrompt);
    repeatCount++;
    resetIdleTimer();

    // Wait for the AI to finish, then process commands and send Discord webhook
    const responseText = await waitForCharacterResponse();
    if (responseText) {
        processCharacterCommands(responseText);
        await sendDiscordWebhook(characterName, responseText);
    }
}


/**
 * Send the provided prompt to the AI as the user.
 * If includePrompt is true, puts the text visibly in the chat via the textarea.
 * If false, sends it silently via promptQuietForLoudResponse.
 * @param {string} prompt - The prompt text to send.
 */
function sendPrompt(prompt) {
    clearTimeout(idleTimer);

    if (extension_settings.idle.useRegenerate) {
        $('#option_regenerate').trigger('click');
        console.debug('Sending idle regenerate');
    } else if (extension_settings.idle.useContinuation) {
        $('#option_continue').trigger('click');
        console.debug('Sending idle continuation');
    } else if (extension_settings.idle.useImpersonation) {
        $('#option_impersonate').trigger('click');
        console.debug('Sending idle impersonation');
    } else if (extension_settings.idle.useSwipe) {
        $('.last_mes .swipe_right').click();
        console.debug('Sending idle swipe');
    } else if (extension_settings.idle.includePrompt) {
        // Send visibly as the user — set textarea value and click send
        const text = substituteParams(prompt);
        const $ta = $('#send_textarea');
        $ta.val(text);
        // Dispatch a native input event so ST's internal state syncs
        $ta[0].dispatchEvent(new Event('input', { bubbles: true }));
        $('#send_but').trigger('click');
        console.debug('Sending idle prompt (visible)');
    } else {
        // Send silently
        promptQuietForLoudResponse('user', prompt);
        console.debug('Sending idle prompt (silent)');
    }
}

/**
 * Build and inject the full settings UI directly into the extensions panel.
 * Replaces the missing dropdown.html template entirely.
 */
function loadSettingsHTML() {
    const html = `
<div id="idle_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Idle</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <div class="idle_block flex-container">
                <label class="checkbox_label flex1" for="idle_enabled">
                    <input id="idle_enabled" type="checkbox" />
                    <span>Enabled</span>
                </label>
            </div>

            <div class="idle_block flex-container flexFlowColumn">
                <label for="idle_timer">Idle timer (seconds)</label>
                <input id="idle_timer" class="text_pole" type="number" min="1" />
            </div>

            <div class="idle_block flex-container flexFlowColumn">
                <label class="checkbox_label" for="idle_random_time">
                    <input id="idle_random_time" type="checkbox" />
                    <span>Random time</span>
                </label>
                <div style="display:none;">
                    <label for="idle_timer_min">Minimum time (seconds)</label>
                    <input id="idle_timer_min" class="text_pole" type="number" min="1" />
                </div>
            </div>

            <div class="idle_block flex-container flexFlowColumn">
                <label for="idle_repeats">Max repeats (0 = infinite)</label>
                <input id="idle_repeats" class="text_pole" type="number" min="0" />
            </div>

            <div class="idle_block flex-container flexFlowColumn">
                <label for="idle_prompts">Idle prompts (one per line)</label>
                <textarea id="idle_prompts" class="text_pole" rows="6"></textarea>
            </div>

            <div class="idle_block flex-container flexFlowColumn">
                <span>Response mode (pick one)</span>
                <label class="checkbox_label" for="idle_use_continuation">
                    <input id="idle_use_continuation" type="checkbox" />
                    <span>Continuation</span>
                </label>
                <label class="checkbox_label" for="idle_use_regenerate">
                    <input id="idle_use_regenerate" type="checkbox" />
                    <span>Regenerate</span>
                </label>
                <label class="checkbox_label" for="idle_use_impersonation">
                    <input id="idle_use_impersonation" type="checkbox" />
                    <span>Impersonation</span>
                </label>
                <label class="checkbox_label" for="idle_use_swipe">
                    <input id="idle_use_swipe" type="checkbox" />
                    <span>Swipe</span>
                </label>
            </div>


            <div class="idle_block flex-container">
                <label class="checkbox_label flex1" for="idle_include_prompt">
                    <input id="idle_include_prompt" type="checkbox" />
                    <span>Include prompt in message</span>
                </label>
            </div>

            <hr style="margin: 10px 0; opacity: 0.3;" />

            <div class="idle_block flex-container flexFlowColumn">
                <b>⏰ Character Commands</b>
                <small style="opacity:0.6; font-size:0.8em; margin-bottom:4px;">
                    Characters can use <code>/reply-in "10 minutes"</code> and
                    <code>/set-self-reminder "message" "date" "time"</code> in their responses.
                </small>

                <label for="idle_reminder_prompt">Reminder prompt template</label>
                <textarea id="idle_reminder_prompt" class="text_pole" rows="3"></textarea>
                <small style="opacity:0.6; font-size:0.8em;">
                    Use <code>{{reminder}}</code> and <code>{{reminder_time}}</code> as placeholders.
                </small>

                <div style="margin-top:8px;">
                    <b style="font-size:0.9em;">Pending reminders</b>
                    <div id="idle_reminders_list" style="margin-top:4px; font-size:0.85em; opacity:0.8;"></div>
                </div>
            </div>

            <hr style="margin: 10px 0; opacity: 0.3;" />

            <div class="idle_block flex-container flexFlowColumn">
                <b>🔔 Discord Webhook Notifications</b>

                <label class="checkbox_label" for="idle_discord_webhook_enabled">
                    <input id="idle_discord_webhook_enabled" type="checkbox" />
                    <span>Enable Discord notifications</span>
                </label>

                <label for="idle_discord_webhook_url">Webhook URL</label>
                <input
                    id="idle_discord_webhook_url"
                    class="text_pole"
                    type="text"
                    placeholder="https://discord.com/api/webhooks/..."
                />
                <small style="opacity:0.6; font-size:0.8em;">
                    Discord channel → Edit Channel → Integrations → Webhooks → Copy Webhook URL
                </small>

                <div style="margin-top:6px; display:flex; align-items:center; gap:8px;">
                    <input id="idle_discord_test_btn" class="menu_button" type="button" value="Send Test Notification" />
                    <span id="idle_discord_test_result" style="font-size:0.85em; opacity:0.7;"></span>
                </div>
            </div>

        </div><!-- /.inline-drawer-content -->
    </div><!-- /.inline-drawer -->
</div><!-- /#idle_container -->`;

    const container = document.getElementById('idle_container') ?? document.getElementById('extensions_settings2');
    $(container).append(html);
}


/**
 * Update a specific setting based on user input.
 * @param {string} elementId - The HTML element ID tied to the setting.
 * @param {string} property - The property name in the settings object.
 * @param {boolean} [isCheckbox=false] - Whether the setting is a checkbox.
 */
function updateSetting(elementId, property, isCheckbox = false) {
    let value = $(`#${elementId}`).val();
    if (isCheckbox) {
        value = $(`#${elementId}`).prop('checked');
    }

    if (property === 'prompts') {
        value = value.split('\n');
    }

    extension_settings.idle[property] = value;
    saveSettingsDebounced();
}

/**
 * Attach an input listener to a UI component to update the corresponding setting.
 * @param {string} elementId - The HTML element ID tied to the setting.
 * @param {string} property - The property name in the settings object.
 * @param {boolean} [isCheckbox=false] - Whether the setting is a checkbox.
 */
function attachUpdateListener(elementId, property, isCheckbox = false) {
    $(`#${elementId}`).on('input', debounce(() => {
        updateSetting(elementId, property, isCheckbox);
    }, 250));
}

/**
 * Handle the enabling or disabling of the idle extension.
 * Adds or removes the idle listeners based on the checkbox's state.
 */
function handleIdleEnabled() {
    if (!extension_settings.idle.enabled) {
        clearTimeout(idleTimer);
        removeIdleListeners();
    } else {
        resetIdleTimer();
        attachIdleListeners();
    }
}


/**
 * Setup input listeners for the various settings and actions related to the idle extension.
 */
function setupListeners() {
    const settingsToWatch = [
        ['idle_timer', 'timer'],
        ['idle_prompts', 'prompts'],
        ['idle_use_continuation', 'useContinuation', true],
        ['idle_use_regenerate', 'useRegenerate', true],
        ['idle_use_impersonation', 'useImpersonation', true],
        ['idle_use_swipe', 'useSwipe', true],
        ['idle_enabled', 'enabled', true],
        ['idle_repeats', 'repeats'],
        ['idle_random_time', 'randomTime', true],
        ['idle_timer_min', 'timerMin'],
        ['idle_include_prompt', 'includePrompt', true],
        // Discord webhook settings
        ['idle_discord_webhook_enabled', 'discordWebhookEnabled', true],
        ['idle_discord_webhook_url', 'discordWebhookUrl'],
        // Reminder settings
        ['idle_reminder_prompt', 'reminderPrompt'],
    ];
    settingsToWatch.forEach(setting => {
        attachUpdateListener(...setting);
    });

    // Idleness listeners, could be made better
    $('#idle_enabled').on('input', debounce(handleIdleEnabled, 250));

    // Add the idle listeners initially if the idle feature is enabled
    if (extension_settings.idle.enabled) {
        attachIdleListeners();
    }

    // Make continuation, regenerate, impersonation, and swipe mutually exclusive
    $('#idle_use_continuation, #idle_use_regenerate, #idle_use_impersonation, #idle_use_swipe').on('change', function() {
        const checkboxId = $(this).attr('id');

        if ($(this).prop('checked')) {
            // Uncheck the other options
            if (checkboxId !== 'idle_use_continuation') {
                $('#idle_use_continuation').prop('checked', false);
                extension_settings.idle.useContinuation = false;
            }

            if (checkboxId !== 'idle_use_regenerate') {
                $('#idle_use_regenerate').prop('checked', false);
                extension_settings.idle.useRegenerate = false;
            }

            if (checkboxId !== 'idle_use_impersonation') {
                $('#idle_use_impersonation').prop('checked', false);
                extension_settings.idle.useImpersonation = false;
            }

            if (checkboxId !== 'idle_use_swipe') {
                $('#idle_use_swipe').prop('checked', false);
                extension_settings.idle.useSwipe = false;
            }

            // Save the changes
            saveSettingsDebounced();
        }
    });

    //show/hide timer min parent div
    $('#idle_random_time').on('input', function () {
        if ($(this).prop('checked')) {
            $('#idle_timer_min').parent().show();
        } else {
            $('#idle_timer_min').parent().hide();
        }

        $('#idle_timer').trigger('input');
    });

    // if we're including the prompt, show/hide has no sendAs dropdown to worry about anymore

    //make sure timer min is less than timer
    $('#idle_timer').on('input', function () {
        if ($('#idle_random_time').prop('checked')) {
            if ($(this).val() < $('#idle_timer_min').val()) {
                $('#idle_timer_min').val($(this).val());
                $('#idle_timer_min').trigger('input');
            }
        }
    });

    // Discord webhook test button
    $('#idle_discord_test_btn').on('click', async function () {
        const resultEl = $('#idle_discord_test_result');
        const context = getContext();
        const characterName = context.name2 || 'Test Character';
        const testMessage = '*waves hello from the Idle extension!*';

        resultEl.text('Sending…').css('opacity', '0.7');

        const webhookUrl = extension_settings.idle.discordWebhookUrl?.trim();
        if (!webhookUrl) {
            resultEl.text('⚠ No webhook URL set.').css('opacity', '1');
            return;
        }

        const payload = {
            username: characterName,
            content: `💬 **${characterName}** sent an idle message:`,
            embeds: [
                {
                    description: testMessage,
                    color: 0x5865F2,
                    footer: { text: 'SillyTavern • Idle Extension — Test Notification' },
                    timestamp: new Date().toISOString(),
                },
            ],
        };

        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (response.ok) {
                resultEl.text('✓ Test sent!').css('opacity', '1');
            } else {
                resultEl.text(`✗ Error ${response.status}`).css('opacity', '1');
            }
        } catch (err) {
            resultEl.text('✗ Network error').css('opacity', '1');
            console.error('Discord test webhook error:', err);
        }

        setTimeout(() => resultEl.text('').css('opacity', '0.7'), 4000);
    });
}

const debouncedActivityHandler = debounce((event) => {
    // Check if the event target (or any of its parents) has the id "option_continue"
    if ($(event.target).closest('#option_continue').length) {
        return; // Do not proceed if the click was on (or inside) an element with id "option_continue"
    }

    console.debug('Activity detected, resetting idle timer');
    resetIdleTimer();
    repeatCount = 0;
}, 250);

function attachIdleListeners() {
    $(document).on('click keypress', debouncedActivityHandler);
    document.addEventListener('keydown', debouncedActivityHandler);
}

/**
 * Remove idle-specific listeners.
 */
function removeIdleListeners() {
    $(document).off('click keypress', debouncedActivityHandler);
    document.removeEventListener('keydown', debouncedActivityHandler);
}

function toggleIdle() {
    extension_settings.idle.enabled = !extension_settings.idle.enabled;
    $('#idle_enabled').prop('checked', extension_settings.idle.enabled);
    $('#idle_enabled').trigger('input');
    toastr.info(`Idle mode ${extension_settings.idle.enabled ? 'enabled' : 'disabled'}.`);
    resetIdleTimer();
}



jQuery(() => {
    loadSettingsHTML();
    loadSettings();
    setupListeners();
    startReminderHeartbeat();
    if (extension_settings.idle.enabled) {
        resetIdleTimer();
    }
    // once the doc is ready, check if random time is checked and hide/show timer min
    if ($('#idle_random_time').prop('checked')) {
        $('#idle_timer_min').parent().show();
    }
    registerSlashCommand('idle', toggleIdle, [], '– toggles idle mode', true, true);
});
