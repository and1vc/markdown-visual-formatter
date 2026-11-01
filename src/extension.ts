

import * as vscode from 'vscode';

const PRESET_COLORS = [

    '#FFFFFF', '#000000', '#F0F0E8', '#4472C4', '#5B9BD5',

    '#C0504D', '#9BBB59', '#8064A2', '#4BACC6', '#F79646',

    '#FF0000', '#FF9900', '#FFFF00', '#00B050', '#00B0F0',

    '#0070C0', '#7030A0', '#FF69B4', '#90EE90', '#ADD8E6',

    '#A52A2A', '#40E0D0', '#DDEBF7', '#E2F0D9', '#FCE4D6'

];

type ColorType = 'textColors' | 'backgroundColors';

type PaletteMode = 'text' | 'background';

interface FormatterMetadata {

    textColors?: string[];

    backgroundColors?: string[];

}

interface MarkdownTarget {

    notebook: vscode.NotebookDocument;

    editor: vscode.TextEditor;

    selection: vscode.Selection;

    selectedText: string;

}

function isValidColor(color: string): boolean {

    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);

}

function escapeHtml(text: string): string {

    return text

        .replace(/&/g, '&amp;')

        .replace(/</g, '&lt;')

        .replace(/>/g, '&gt;');

}


/**
 * Elimina únicamente el formato gestionado por esta extensión:
 * <mark> y las propiedades color/background-color de los elementos <span>.
 * Conserva el contenido y los demás estilos/atributos cuando existan.
 */
function clearFormatterMarkup(input: string): string {
    let output = input;

    // Eliminar etiquetas de resaltado, incluidas las que estén escapadas.
    output = output
        .replace(/<\/?mark\b[^>]*>/gi, '')
        .replace(/&lt;\/?mark(?:\s[^&]*?)?&gt;/gi, '');

    // Repetir sobre spans simples permite limpiar primero los elementos interiores.
    const spanPattern = /<span\b([^<>]*)>([^<>]*)<\/span>/i;
    for (let i = 0; i < 100; i++) {
        let changed = false;
        output = output.replace(spanPattern, (whole, rawAttributes: string, content: string) => {
            const styleMatch = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(rawAttributes);
            if (!styleMatch) {
                return whole;
            }

            const style = styleMatch[2];
            const declarations = style
                .split(';')
                .map(item => item.trim())
                .filter(Boolean);
            const remaining = declarations.filter(declaration => {
                const property = declaration.split(':', 1)[0].trim().toLowerCase();
                return property !== 'color' && property !== 'background-color';
            });

            if (remaining.length === declarations.length) {
                return whole;
            }

            changed = true;
            let attributes = rawAttributes.replace(styleMatch[0], '');
            if (remaining.length > 0) {
                const quote = styleMatch[1];
                const replacementStyle = `style=${quote}${remaining.join('; ')}${quote}`;
                attributes = `${attributes} ${replacementStyle}`;
            }

            attributes = attributes.trim();
            if (!attributes) {
                return content;
            }

            return `<span ${attributes}>${content}</span>`;
        });

        if (!changed) {
            break;
        }
    }

    return output;
}

async function getMarkdownTarget(): Promise<MarkdownTarget | undefined> {

    const notebookEditor = vscode.window.activeNotebookEditor;

    const textEditor = vscode.window.activeTextEditor;

    if (!notebookEditor || !textEditor) {

        vscode.window.showWarningMessage(

            'Abre un notebook y selecciona texto en una celda Markdown.'

        );

        return undefined;

    }

    const cell = notebookEditor.notebook.getCells().find(

        item => item.document.uri.toString() ===

            textEditor.document.uri.toString()

    );

    if (!cell || cell.kind !== vscode.NotebookCellKind.Markup) {

        vscode.window.showWarningMessage(

            'Este comando solo funciona en celdas Markdown.'

        );

        return undefined;

    }

    const selection = textEditor.selection;

    if (selection.isEmpty) {

        vscode.window.showWarningMessage(

            'Selecciona primero el texto que quieres modificar.'

        );

        return undefined;

    }

    return {

        notebook: notebookEditor.notebook,

        editor: textEditor,

        selection,

        selectedText: textEditor.document.getText(selection)

    };

}

async function saveRecentColor(

    notebook: vscode.NotebookDocument,

    type: ColorType,

    color: string

): Promise<boolean> {

    const metadata = { ...notebook.metadata };

    const formatterMetadata = {

        ...(

            metadata.markdownVisualFormatter as FormatterMetadata | undefined

        )

    };

    const previousColors = Array.isArray(formatterMetadata[type])

        ? formatterMetadata[type]!

        : [];

    formatterMetadata[type] = [

        color,

        ...previousColors.filter(item => item !== color)

    ].slice(0, 12);

    metadata.markdownVisualFormatter = formatterMetadata;

    const edit = new vscode.WorkspaceEdit();

    edit.set(

        notebook.uri,

        [

            vscode.NotebookEdit.updateNotebookMetadata(metadata)

        ]

    );

    return vscode.workspace.applyEdit(edit);

}


interface ExistingColorEdit {
    range: vscode.Range;
    replacement: string;
}

function getExistingColorEdit(
    target: MarkdownTarget,
    mode: PaletteMode,
    color: string
): ExistingColorEdit | undefined {
    const document = target.editor.document;
    const source = document.getText();

    const start = document.offsetAt(target.selection.start);
    const end = document.offsetAt(target.selection.end);

    const closeTag = '</span>';
    let openStart: number;
    let openEnd: number;
    let closeStart: number;

    // Acepta tanto el span completo como la selección exacta de su contenido.
    const selectedOpeningTag = source.slice(start, end).match(/^<span\b[^>]*>/i);
    if (selectedOpeningTag && source.slice(end - closeTag.length, end) === closeTag) {
        openStart = start;
        openEnd = start + selectedOpeningTag[0].length - 1;
        closeStart = end - closeTag.length;
    } else {
        openStart = source.lastIndexOf('<span', start);
        if (openStart < 0) {
            return undefined;
        }

        openEnd = source.indexOf('>', openStart);
        if (openEnd < 0 || openEnd >= start) {
            return undefined;
        }

        closeStart = source.indexOf(closeTag, end);
        if (closeStart < 0 || openEnd + 1 !== start || closeStart !== end) {
            return undefined;
        }
    }

    const openingTag = source.slice(openStart, openEnd + 1);
    const property = mode === 'text'
        ? 'color'
        : 'background-color';

    const styleAttribute = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(openingTag);
    if (!styleAttribute || styleAttribute.index === undefined) {
        return undefined;
    }

    const style = styleAttribute[2];
    const styleStart = openStart + styleAttribute.index +
        styleAttribute[0].indexOf(style);
    const propertyPattern = new RegExp(
        '(^|;)\\s*' + property +
        '\\s*:\\s*(#(?:[0-9a-f]{3}|[0-9a-f]{6}))(?=\\s*(?:;|$))',
        'i'
    );
    const existingProperty = propertyPattern.exec(style);

    if (existingProperty && existingProperty.index !== undefined) {
        const colorStart = styleStart + existingProperty.index +
            existingProperty[0].indexOf(existingProperty[2]);

        return {
            range: new vscode.Range(
                document.positionAt(colorStart),
                document.positionAt(colorStart + existingProperty[2].length)
            ),
            replacement: color
        };
    }

    const separator = style.trim().length
        ? (style.trimEnd().endsWith(';') ? ' ' : '; ')
        : '';

    return {
        range: new vscode.Range(
            document.positionAt(styleStart + style.length),
            document.positionAt(styleStart + style.length)
        ),
        replacement: `${separator}${property}: ${color}`
    };
}




async function applyColor(
    target: MarkdownTarget,
    mode: PaletteMode,
    color: string
): Promise<void> {
    if (!isValidColor(color)) {
        vscode.window.showErrorMessage(
            'El color seleccionado no es válido.'
        );
        return;
    }

    const normalizedColor = color.toUpperCase();
    const existingColorEdit = getExistingColorEdit(
        target,
        mode,
        normalizedColor
    );
    const replacementRange = existingColorEdit?.range ?? target.selection;
    const replacement = existingColorEdit?.replacement ?? (mode === 'text'
        ? `<span style="color: ${normalizedColor};">${escapeHtml(target.selectedText)}</span>`
        : `<span style="background-color: ${normalizedColor};">${escapeHtml(target.selectedText)}</span>`);

    const success = await target.editor.edit(editBuilder => {
        editBuilder.replace(replacementRange, replacement);
    });

    if (!success) {
        vscode.window.showErrorMessage(
            'No se pudo aplicar el formato al texto seleccionado.'
        );
        return;
    }

    const metadataSaved = await saveRecentColor(
        target.notebook,
        mode === 'text' ? 'textColors' : 'backgroundColors',
        normalizedColor
    );

    if (!metadataSaved) {
        vscode.window.showWarningMessage(
            'El color se aplicó, pero no se pudo guardar el historial.'
        );
        return;
    }

    vscode.window.setStatusBarMessage(
        `Color aplicado: ${normalizedColor}`,
        3000
    );
}


function getRecentColors(

    notebook: vscode.NotebookDocument,

    mode: PaletteMode

): string[] {

    const metadata = notebook.metadata.markdownVisualFormatter as FormatterMetadata | undefined;

    const type: ColorType = mode === 'text'

        ? 'textColors'

        : 'backgroundColors';

    return (metadata?.[type] ?? []).filter(isValidColor);

}

function createPaletteHtml(

    webview: vscode.Webview,

    mode: PaletteMode,

    recentColors: string[]

): string {

    const nonce = getNonce();

    const title = mode === 'text'

        ? 'Color de texto'

        : 'Color de fondo';

    const recentHtml = recentColors.length

        ? `

            <h3>Colores recientes</h3>

            <div class="palette">${recentColors.map(color =>

                `<button class="swatch" data-color="${color}"

                    title="${color}" aria-label="${color}"

                    style="background-color:${color}"></button>`

            ).join('')}</div>

        `

        : '';

    const presetHtml = PRESET_COLORS.map(color =>

        `<button class="swatch" data-color="${color}"

            title="${color}" aria-label="${color}"

            style="background-color:${color}"></button>`

    ).join('');

    return /* html */ `

<!DOCTYPE html>

<html lang="es">

<head>

<meta charset="UTF-8">

<meta

    http-equiv="Content-Security-Policy"

    content="default-src 'none'; style-src 'unsafe-inline';

             script-src 'nonce-${nonce}';"

\>

<meta name="viewport" content="width=device-width, initial-scale=1.0">

<style>

    body {

        padding: 18px;

        color: var(--vscode-foreground);

        background: var(--vscode-editor-background);

        font-family: var(--vscode-font-family);

    }

    h2 { font-size: 18px; margin-top: 0; }

    h3 {

        font-size: 12px;

        font-weight: normal;

        margin: 22px 0 10px;

        color: var(--vscode-descriptionForeground);

    }

    .palette {

        display: grid;

        grid-template-columns: repeat(5, 34px);

        gap: 8px;

    }

    .swatch {

        width: 34px;

        height: 34px;

        border-radius: 4px;

        border: 1px solid var(--vscode-panel-border);

        cursor: pointer;

        padding: 0;

    }

    .swatch:hover, .swatch:focus {

        outline: 2px solid var(--vscode-focusBorder);

        outline-offset: 2px;

    }

    .custom {

        display: flex;

        align-items: center;

        gap: 12px;

        margin-top: 22px;

    }

    input[type="color"] {

        width: 44px;

        height: 38px;

        padding: 2px;

        cursor: pointer;

        background: var(--vscode-input-background);

        border: 1px solid var(--vscode-panel-border);

    }

    button.action {

        margin-top: 12px;

        padding: 7px 12px;

        color: var(--vscode-button-foreground);

        background: var(--vscode-button-background);

        border: none;

        cursor: pointer;

    }

    button.action:hover {

        background: var(--vscode-button-hoverBackground);

    }

    .hint {

        color: var(--vscode-descriptionForeground);

        font-size: 12px;

    }

</style>

</head>

<body>

    <h2>${title}</h2>

    ${recentHtml}

    <h3>Colores predefinidos</h3>

    <div class="palette">${presetHtml}</div>

    <h3>Color personalizado</h3>

    <div class="custom">

        <input id="customColor" type="color" value="#FF9900">

        <span id="colorValue">#FF9900</span>

    </div>

    <button class="action" id="applyCustom">

        Aplicar color personalizado

    </button>

    <p class="hint">

        Selecciona un color para aplicarlo al texto marcado en la celda.

    </p>

<script nonce="${nonce}">

    const vscode = acquireVsCodeApi();

    const picker = document.getElementById('customColor');

    const colorValue = document.getElementById('colorValue');

    picker.addEventListener('input', () => {

        colorValue.textContent = picker.value.toUpperCase();

    });

    document.querySelectorAll('.swatch').forEach(button => {

        button.addEventListener('click', () => {

            vscode.postMessage({

                type: 'applyColor',

                color: button.dataset.color

            });

        });

    });

    document.getElementById('applyCustom').addEventListener('click', () => {

        vscode.postMessage({

            type: 'applyColor',

            color: picker.value

        });

    });

</script>

</body>

</html>`;

}

function getNonce(): string {

    const chars =

        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    let value = '';

    for (let i = 0; i < 32; i++) {

        value += chars.charAt(Math.floor(Math.random() * chars.length));

    }

    return value;

}

async function openColorPalette(

    context: vscode.ExtensionContext,

    mode: PaletteMode

): Promise<void> {

    const target = await getMarkdownTarget();

    if (!target) {

        return;

    }

    const panel = vscode.window.createWebviewPanel(

        'markdownVisualFormatter.palette',

        mode === 'text' ? 'Color de texto' : 'Color de fondo',

        vscode.ViewColumn.Beside,

        {

            enableScripts: true,

            retainContextWhenHidden: true

        }

    );

    const recentColors = getRecentColors(target.notebook, mode);

    panel.webview.html = createPaletteHtml(

        panel.webview,

        mode,

        recentColors

    );

    panel.webview.onDidReceiveMessage(

        async message => {

            if (

                message.type !== 'applyColor' ||

                typeof message.color !== 'string' ||

                !isValidColor(message.color)

            ) {

                return;

            }

            await applyColor(target, mode, message.color);

            panel.dispose();

        },

        undefined,

        context.subscriptions

    );

    context.subscriptions.push(panel);

}

export function activate(context: vscode.ExtensionContext): void {

    const highlightCommand = vscode.commands.registerCommand(

        'markdown-visual-formatter.highlightText',

        async () => {

            const target = await getMarkdownTarget();

            if (!target) {

                return;

            }

            
const selected = target.selectedText.trim();

const existingMark = selected.match(
    /^<mark\b[^>]*>([\s\S]*)<\/mark>$/i
);

const escapedMark = selected.match(
    /^&lt;mark(?:\s[^&]*?)?&gt;([\s\S]*)&lt;\/mark&gt;$/i
);

// Si se selecciona un resaltado completo, conservar su contenido
// y evitar escapar las etiquetas existentes.
const content = existingMark
    ? existingMark[1]
    : escapedMark
        ? escapedMark[1]
        : escapeHtml(target.selectedText);

const replacement = `<mark>${content}</mark>`;
;

            const success = await target.editor.edit(editBuilder => {

                editBuilder.replace(target.selection, replacement);

            });

            if (success) {

                vscode.window.setStatusBarMessage(

                    'Resaltado aplicado.',

                    3000

                );

            }

        }

    );

    const clearFormattingCommand = vscode.commands.registerCommand(
        'markdown-visual-formatter.clearFormatting',
        async () => {
            const target = await getMarkdownTarget();
            if (!target) {
                return;
            }

            const replacement = clearFormatterMarkup(target.selectedText);
            if (replacement === target.selectedText) {
                vscode.window.setStatusBarMessage(
                    'No se encontró formato compatible para borrar.',
                    3000
                );
                return;
            }

            const success = await target.editor.edit(editBuilder => {
                editBuilder.replace(target.selection, replacement);
            });

            if (success) {
                vscode.window.setStatusBarMessage(
                    'Formato de texto eliminado.',
                    3000
                );
            } else {
                vscode.window.showErrorMessage(
                    'No se pudo eliminar el formato del texto seleccionado.'
                );
            }
        }
    );

    const textColorCommand = vscode.commands.registerCommand(

        'markdown-visual-formatter.setTextColor',

        async () => {

            await openColorPalette(context, 'text');

        }

    );

    const backgroundColorCommand = vscode.commands.registerCommand(

        'markdown-visual-formatter.setBackgroundColor',

        async () => {

            await openColorPalette(context, 'background');

        }

    );

    context.subscriptions.push(

        highlightCommand,

        textColorCommand,

        backgroundColorCommand

    );

}

export function deactivate(): void {}
