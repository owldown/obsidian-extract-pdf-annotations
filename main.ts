import { App, Editor, MarkdownView, TFile, Vault, Plugin, PluginSettingTab, Setting, loadPdfJs } from 'obsidian';
import { loadPDFFile } from 'extractHighlight'

function template(strings, ...keys) {
	return (function (...values) {
		const dict = values[values.length - 1] || {};
		const result = [strings[0]];
		keys.forEach(function (key, i) {
			const value = Number.isInteger(key) ? values[key] : dict[key];
			result.push(value, strings[i + 1]);
		});
		return result.join('');
	});
}

// templates for different types of Annotations
//const highlighted = template`> ${'highlightedText'}
//
//${'body'}
//			    
//* *highlighted by ${'author'} at page ${'pageNumber'} on [[${'filepath'}]]*
//
//`

const highlighted = template`> [!CITE]${'highlightedText'}
> _page ${'pageNumber'}_
> ${'body'}

`

//const note = template`${'body'}
// 
//* *noted by ${'author'} at page ${'pageNumber'} on [[${'filepath'}]]*
//
//`

const note = template`> [!NOTE]
> _page ${'pageNumber'}_
> ${'body'}

`


export default class PDFAnnotationPlugin extends Plugin {

	public settings: PDFAnnotationPluginSetting;

	sort (grandtotal) {
		const settings = this.settings

		if (settings.sortByTopic) {
			grandtotal.forEach((anno) => {
				const lines = anno.body.split(/\r\n|\n\r|\n|\r/); // split by:     \r\n  \n\r  \n  or  \r
				anno.topic = lines[0]; // First line of contents
				anno.body = lines.slice(1).join('\r\n')
			})	
		}

		grandtotal.sort(function (a1, a2) {
			if (settings.sortByTopic) {
				// sort by topic
				if (a1.topic > a2.topic) return 1
				if (a1.topic < a2.topic) return -1
			}

			if (settings.useFolderNames) {
				// then sort by folder  
				if (a1.folder > a2.folder) return 1
				if (a1.folder < a2.folder) return -1
			}

			// then sort by file.name  
			if (a1.file.name > a2.file.name) return 1
			if (a1.file.name < a2.file.name) return -1

			// then sort by page
			if (a1.pageNumber > a2.pageNumber) return 1
			if (a1.pageNumber < a2.pageNumber) return -1

			// they are on the same, page, sort (descending) by minY
			// if quadPoints are undefined, use minY from the rect-angle
			if (a1.rect[1] > a2.rect[1]) return -1
			if (a1.rect[1] < a2.rect[1]) return 1
			return 0
		})
	}

	format(grandtotal) {
		// now iterate over the annotations printing topics, then folder, then comments...
		let text = ''
		let topic = ''
		let currentFolder = ''
		// console.log("all annots", grandtotal)
		grandtotal.forEach((a) => {
			// print main Title when Topic changes (and settings allow)
			if (this.settings.sortByTopic) {
				if (topic != a.topic) {
					topic = a.topic
					currentFolder = ''
					text += `# ${topic}\n`
				}
			}

			if (this.settings.useFolderNames) {
				if (currentFolder != a.folder) {
					currentFolder = a.folder
					text += `## ${currentFolder}\n`
				}
			} else {
				if (currentFolder != a.file.name) {
					currentFolder = a.file.name
					text += `# ${currentFolder}\n`
					text += `[[`
					text += a.file.path
					text += `]]\n\n`
					
				}  
			}

			if (a.subtype == 'Text') {
				text += note(a)
			} else {
				text += highlighted(a)
			}
		})

		if (grandtotal.length == 0) return '*No Annotations*'
		else return text
	}

	async loadSinglePDFFile(file : TFile) {
		const pdfjsLib = await loadPdfJs()
		const containingFolder = file.parent.name;
		const grandtotal = [] // array that will contain all fetched Annotations
		console.log('loading from file ', file)
		await loadPDFFile(file, pdfjsLib, containingFolder, grandtotal)
		this.sort(grandtotal)
		const finalMarkdown = this.format(grandtotal)
// instead of the root of the vault, save next to the pdf itself with file.path
		let filePath = file.path.replace(".pdf", ".annotations.md");
//		filePath = containingFolder + "/Annotations for " + filePath;
		await this.saveHighlightsToFile(filePath, finalMarkdown);
		await this.app.workspace.openLinkText(filePath, '', true);						
	}

	async onload() {
		this.loadSettings();
		this.addSettingTab(new PDFAnnotationPluginSettingTab(this.app, this));

		this.addCommand({
			id: 'extract-annotations-single',
			name: 'Extract PDF Annotations on single file',
			checkCallback: (checking : boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file != null && file.extension === 'pdf') {
					if (!checking) {
						// load file if (not only checking) && conditions are valid
						this.loadSinglePDFFile(file)
					}
					return true
				} else {
					return false
				}
			} 	
		})

		this.addCommand({
			id: 'extract-annotations',
			name: 'Extract PDF Annotations',
			editorCallback: async (editor: Editor, view: MarkdownView) => { 
				const file = this.app.workspace.getActiveFile()
				if (file == null) return
				const folder = file.parent
				const grandtotal = [] // array that will contain all fetched Annotations

				const pdfjsLib = await loadPdfJs()
				editor.replaceSelection('Extracting PDF Comments from ' + folder.name + '\n')

				const promises = [] // when all Promises will be resolved. 

				Vault.recurseChildren(folder, async (file) => {
					// visit all Childern of parent folder of current active File
					if (file instanceof TFile) {
						if (file.extension === 'pdf') {
							promises.push(loadPDFFile(file, pdfjsLib, file.parent.name, grandtotal)) 
						}
					}
				})
				await Promise.all(promises)
				this.sort(grandtotal)
				editor.replaceSelection(this.format(grandtotal))
			}
		})
	}


	loadSettings() {
		this.settings = new PDFAnnotationPluginSetting();
		(async () => {
			const loadedSettings = await this.loadData();
			if (loadedSettings) {
				this.settings.useFolderNames = loadedSettings.useFolderNames;
				this.settings.sortByTopic = loadedSettings.sortByTopic;
			} 
		})();
	}

	onunload() {}

	async saveHighlightsToFile(filePath: string, mdString: string) {
		const fileExists = await this.app.vault.adapter.exists(filePath);
		if (fileExists) {
			await this.appendHighlightsToFile(filePath, mdString);
		} else {
			await this.app.vault.create(filePath, mdString);
		}
	}

	async appendHighlightsToFile(filePath: string, note: string) {
		let existingContent = await this.app.vault.adapter.read(filePath);
		if(existingContent.length > 0) {
			existingContent = existingContent + '\r\r';
		}
		await this.app.vault.adapter.write(filePath, existingContent + note);
	}


}



class PDFAnnotationPluginSetting {
    public useFolderNames: boolean;
    public sortByTopic: boolean;

    constructor() {
        this.useFolderNames = true;
        this.sortByTopic = true;
    }
}

class PDFAnnotationPluginSettingTab extends PluginSettingTab {
    plugin: PDFAnnotationPlugin;

    constructor(app: App, plugin: PDFAnnotationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Use Folder Name')
            .setDesc(
                'If enabled, uses the PDF\'s folder name (instead of the PDF-Filename) for sorting',
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.useFolderNames).onChange((value) => {
                    this.plugin.settings.useFolderNames = value;
                    this.plugin.saveData(this.plugin.settings);

                }),
            );

        new Setting(containerEl)
            .setName('Sort by Topic')
            .setDesc(
                'If enabled, uses the notes first line as Topic for primary sorting',
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.sortByTopic).onChange((value) => {
                    this.plugin.settings.sortByTopic = value;
                    this.plugin.saveData(this.plugin.settings);
                }),
            );
        
    }
}


