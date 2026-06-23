import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../shared/types';
import { getSharedCopy } from '../../../shared/i18n';
import type { InternalToolContext, InternalToolModule } from '../types';
import { ChromeExtensionBridgeManager } from './manager';
import {
  CHROME_EXTENSION_NATIVE_HOST_NAME,
  CHROME_EXTENSION_TOOL_ID,
  type ChromeExtensionCommandResponse,
} from './types';

const ACTION_PREFIX = `${CHROME_EXTENSION_TOOL_ID}.`;
const defaultDefinitionCopy = getSharedCopy().officialTools.forger_chrome_extension;
const defaultActionCopy = defaultDefinitionCopy.actions;

const definition: OfficialToolDefinition = {
  id: CHROME_EXTENSION_TOOL_ID,
  name: defaultDefinitionCopy.name,
  description: defaultDefinitionCopy.description,
  version: '0.1.0',
  runtime: 'builtin',
  official: true,
  secrets: [],
  actions: [
    {
      id: `${ACTION_PREFIX}connection.status`,
      name: defaultActionCopy[`${ACTION_PREFIX}connection.status`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}connection.status`].description,
      risk: 'low',
    },
    {
      id: `${ACTION_PREFIX}open_dedicated_tab`,
      name: defaultActionCopy[`${ACTION_PREFIX}open_dedicated_tab`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}open_dedicated_tab`].description,
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}get_current_url`,
      name: defaultActionCopy[`${ACTION_PREFIX}get_current_url`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}get_current_url`].description,
      risk: 'low',
    },
    {
      id: `${ACTION_PREFIX}navigate`,
      name: defaultActionCopy[`${ACTION_PREFIX}navigate`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}navigate`].description,
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}get_html`,
      name: defaultActionCopy[`${ACTION_PREFIX}get_html`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}get_html`].description,
      risk: 'high',
    },
    {
      id: `${ACTION_PREFIX}wait_for_selector`,
      name: defaultActionCopy[`${ACTION_PREFIX}wait_for_selector`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}wait_for_selector`].description,
      risk: 'low',
    },
    {
      id: `${ACTION_PREFIX}click`,
      name: defaultActionCopy[`${ACTION_PREFIX}click`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}click`].description,
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}focus`,
      name: defaultActionCopy[`${ACTION_PREFIX}focus`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}focus`].description,
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}hover`,
      name: defaultActionCopy[`${ACTION_PREFIX}hover`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}hover`].description,
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}input_text`,
      name: defaultActionCopy[`${ACTION_PREFIX}input_text`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}input_text`].description,
      risk: 'high',
    },
    {
      id: `${ACTION_PREFIX}submit_form`,
      name: defaultActionCopy[`${ACTION_PREFIX}submit_form`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}submit_form`].description,
      risk: 'high',
    },
    {
      id: `${ACTION_PREFIX}get_styles`,
      name: defaultActionCopy[`${ACTION_PREFIX}get_styles`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}get_styles`].description,
      risk: 'low',
    },
    {
      id: `${ACTION_PREFIX}set_styles`,
      name: defaultActionCopy[`${ACTION_PREFIX}set_styles`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}set_styles`].description,
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}close_window`,
      name: defaultActionCopy[`${ACTION_PREFIX}close_window`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}close_window`].description,
      risk: 'medium',
    },
    {
      id: `${ACTION_PREFIX}close_session`,
      name: defaultActionCopy[`${ACTION_PREFIX}close_session`].name,
      description: defaultActionCopy[`${ACTION_PREFIX}close_session`].description,
      risk: 'medium',
    },
  ],
  changelog: [...defaultDefinitionCopy.changelog],
};

let manager: ChromeExtensionBridgeManager | null = null;

const getManager = (): ChromeExtensionBridgeManager => {
  manager ??= new ChromeExtensionBridgeManager();
  return manager;
};

const configure = async (context: InternalToolContext): Promise<ToolMutationResult> => {
  const copy = getSharedCopy(context.locale);
  try {
    const status = await getManager().configure(context);
    return {
      success: true,
      userMessage: status.connected ? copy.tools.chromeExtensionConnected : copy.tools.chromeExtensionWaiting,
    };
  } catch (error) {
    return {
      success: false,
      userMessage: copy.tools.chromeExtensionConfigureFailed,
      technicalCode: error instanceof Error ? error.message : 'chrome_extension_configure_failed',
    };
  }
};

const toToolResult = (response: ChromeExtensionCommandResponse, fallbackCode: string, fallbackMessage: string): CallOfficialToolResult => {
  if (response.success) {
    return { success: true, data: response.data };
  }
  return {
    success: false,
    userMessage: response.error?.message ?? fallbackMessage,
    technicalCode: response.error?.code ?? fallbackCode,
  };
};

const execute = async (
  input: CallOfficialToolInput,
  context: InternalToolContext,
): Promise<CallOfficialToolResult> => {
  const toolManager = getManager();
  const copy = getSharedCopy(context.locale).tools.chromeExtension;
  try {
    if (input.actionId === `${ACTION_PREFIX}connection.status`) {
      return { success: true, data: await toolManager.status(context) };
    }
    if (input.actionId === `${ACTION_PREFIX}open_dedicated_tab`) {
      const parsed = toolManager.parseOpenDedicatedTabInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidOpen, technicalCode: 'chrome_extension_open_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'open_dedicated_tab', parsed), 'chrome_extension_open_failed', copy.openFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}get_current_url`) {
      const parsed = toolManager.parseSessionInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidSessionReview, technicalCode: 'chrome_extension_session_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'get_current_url', parsed), 'chrome_extension_url_failed', copy.urlFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}navigate`) {
      const parsed = toolManager.parseNavigateInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidNavigate, technicalCode: 'chrome_extension_navigate_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'navigate', parsed), 'chrome_extension_navigate_failed', copy.navigateFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}get_html`) {
      const parsed = toolManager.parseSelectorInput(input.input, { allowMissingSelector: true });
      if (!parsed) {
        return { success: false, userMessage: copy.invalidHtml, technicalCode: 'chrome_extension_html_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'get_html', parsed), 'chrome_extension_html_failed', copy.htmlFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}wait_for_selector`) {
      const parsed = toolManager.parseWaitForSelectorInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidWaitForSelector, technicalCode: 'chrome_extension_wait_for_selector_input_invalid' };
      }
      return toToolResult(
        await toolManager.sendCommand(context, 'wait_for_selector', parsed, { timeoutMs: parsed.commandTimeoutMs }),
        'chrome_extension_wait_for_selector_failed',
        copy.waitForSelectorFailed,
      );
    }
    if (input.actionId === `${ACTION_PREFIX}click` || input.actionId === `${ACTION_PREFIX}focus` || input.actionId === `${ACTION_PREFIX}hover`) {
      const action = input.actionId.slice(ACTION_PREFIX.length);
      const parsed = toolManager.parseSelectorInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidSelector, technicalCode: 'chrome_extension_selector_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, action, parsed), `chrome_extension_${action}_failed`, copy.elementActionFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}input_text`) {
      const parsed = toolManager.parseSelectorInput(input.input, { includeText: true });
      if (!parsed) {
        return { success: false, userMessage: copy.invalidInputText, technicalCode: 'chrome_extension_input_text_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'input_text', parsed), 'chrome_extension_input_failed', copy.inputFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}submit_form`) {
      const parsed = toolManager.parseSubmitFormInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidSubmitForm, technicalCode: 'chrome_extension_submit_form_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'submit_form', parsed), 'chrome_extension_submit_form_failed', copy.submitFormFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}get_styles`) {
      const parsed = toolManager.parseStylesInput(input.input, { includeStyles: false });
      if (!parsed) {
        return { success: false, userMessage: copy.invalidGetStyles, technicalCode: 'chrome_extension_get_styles_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'get_styles', parsed), 'chrome_extension_get_styles_failed', copy.getStylesFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}set_styles`) {
      const parsed = toolManager.parseStylesInput(input.input, { includeStyles: true });
      if (!parsed) {
        return { success: false, userMessage: copy.invalidSetStyles, technicalCode: 'chrome_extension_set_styles_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'set_styles', parsed), 'chrome_extension_set_styles_failed', copy.setStylesFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}close_window`) {
      const parsed = toolManager.parseSessionInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidCloseWindow, technicalCode: 'chrome_extension_close_window_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'close_window', parsed), 'chrome_extension_close_window_failed', copy.closeWindowFailed);
    }
    if (input.actionId === `${ACTION_PREFIX}close_session`) {
      const parsed = toolManager.parseSessionInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: copy.invalidCloseSession, technicalCode: 'chrome_extension_close_input_invalid' };
      }
      return toToolResult(await toolManager.sendCommand(context, 'close_session', parsed), 'chrome_extension_close_failed', copy.closeSessionFailed);
    }
    return { success: false, userMessage: copy.unknownAction, technicalCode: 'chrome_extension_action_unknown' };
  } catch (error) {
    return {
      success: false,
      userMessage: copy.actionFailed,
      technicalCode: error instanceof Error ? error.message : 'chrome_extension_action_failed',
    };
  }
};

export const chromeExtensionToolModule: InternalToolModule = {
  definition,
  configure,
  execute,
  isConfigured: async (context) => await getManager().isConfigured(context),
  start: async (context) => {
    await getManager().start(context);
  },
  stop: async () => {
    await manager?.stop();
  },
  deactivate: async () => {
    await manager?.stop();
    manager = null;
  },
};

export const __resetChromeExtensionToolForTests = async (): Promise<void> => {
  await manager?.stop();
  manager = null;
};

export { CHROME_EXTENSION_NATIVE_HOST_NAME };
