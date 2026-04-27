function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readNonNegativeInt(value, fieldName) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`site config invalid submitSequence item: ${fieldName}`);
  }
  return value;
}

function readInteger(value, fieldName) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new Error(`site config invalid submitSequence item: ${fieldName}`);
  }
  return value;
}

function normalizeAction(item, index, stepName) {
  if (!item || typeof item !== 'object') {
    throw new Error(`site config invalid submitSequence item: ${stepName}.submitSequence[${index}]`);
  }

  const actionType = asNonEmptyString(item.type) || 'click';
  if (![
    'click',
    'clickExactTextCard',
    'clickExactTextOffset',
    'drag',
    'dragTrackByText',
  ].includes(actionType)) {
    throw new Error(
      `site config invalid submitSequence item: ${stepName}.submitSequence[${index}].type`,
    );
  }

  const selector = asNonEmptyString(item.selector);
  if (!selector) {
    throw new Error(
      `site config invalid submitSequence item: ${stepName}.submitSequence[${index}].selector`,
    );
  }

  const confirmSelector = asNonEmptyString(item.confirmSelector);
  const waitForSelector = asNonEmptyString(item.waitForSelector);
  const fieldPrefix = `${stepName}.submitSequence[${index}]`;
  const waitMs = readNonNegativeInt(item.waitMs, `${fieldPrefix}.waitMs`);
  const distance = readNonNegativeInt(item.distance, `${fieldPrefix}.distance`);
  const steps = readNonNegativeInt(item.steps, `${fieldPrefix}.steps`);
  const offsetX = readInteger(item.offsetX, `${fieldPrefix}.offsetX`);
  const offsetY = readInteger(item.offsetY, `${fieldPrefix}.offsetY`);

  if (['drag', 'dragTrackByText'].includes(actionType) && (!distance || distance <= 0)) {
    throw new Error(
      `site config invalid submitSequence item: ${stepName}.submitSequence[${index}].distance`,
    );
  }

  if (['clickExactTextCard', 'clickExactTextOffset', 'dragTrackByText'].includes(actionType)
    && !asNonEmptyString(item.text)) {
    throw new Error(
      `site config invalid submitSequence item: ${stepName}.submitSequence[${index}].text`,
    );
  }

  return {
    type: actionType,
    selector,
    text: asNonEmptyString(item.text),
    confirmSelector,
    waitForSelector,
    waitMs,
    distance,
    steps,
    offsetX,
    offsetY,
  };
}

export function resolveSubmitActions(siteNode, stepName) {
  const submitSequence = Array.isArray(siteNode?.submitSequence) ? siteNode.submitSequence : [];

  if (submitSequence.length > 0) {
    return submitSequence.map((item, index) => normalizeAction(item, index, stepName));
  }

  const submitSelector = asNonEmptyString(siteNode?.submitSelector);
  if (submitSelector) {
    return [
      {
        type: 'click',
        selector: submitSelector,
        text: undefined,
        confirmSelector: asNonEmptyString(siteNode?.confirmSelector),
        waitForSelector: undefined,
        waitMs: undefined,
        distance: undefined,
        steps: undefined,
        offsetX: undefined,
        offsetY: undefined,
      },
    ];
  }

  throw new Error(`site config missing submit action: ${stepName}`);
}
