import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, Platform, MarkdownView } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

// 插件设置接口
interface TreeGeneratorSettings {
    osType: 'windows' | 'linux';  // 操作系统类型
    maxDepth: number;              // 最大深度（0表示无限制）
    showHidden: boolean;           // 是否显示隐藏文件/文件夹
    excludePatterns: string;       // 排除模式（逗号分隔，如 node_modules,.git）
}

// 默认设置
const DEFAULT_SETTINGS: TreeGeneratorSettings = {
    osType: Platform.isWin ? 'windows' : 'linux',
    maxDepth: 0,
    showHidden: false,
    excludePatterns: 'node_modules,.git,dist,build,.obsidian,.trash'
}

// 树节点接口
interface TreeNode {
    name: string;
    path: string;
    isFile: boolean;
    children: TreeNode[];
    size?: number;  // 文件大小（字节）
}

export default class TreeGeneratorPlugin extends Plugin {
    settings: TreeGeneratorSettings;

    async onload() {
        await this.loadSettings();

        // 注册右键菜单事件
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                // 只在 markdown 文件上显示菜单
                if (file instanceof TFile && file.extension === 'md') {
                    menu.addItem((item) => {
                        item
                            .setTitle('插入目录树结构')
                            .setIcon('folder-tree')
                            .onClick(async () => {
                                await this.insertDirectoryTree(file);
                            });
                    });
                }
            })
        );

        // 添加命令，方便通过命令面板调用
        this.addCommand({
            id: 'insert-directory-tree',
            name: '在当前文档中插入目录树结构',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'md') {
                    if (!checking) {
                        this.insertDirectoryTree(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        // 添加设置选项卡
        this.addSettingTab(new TreeGeneratorSettingTab(this.app, this));
    }

    // 插入目录树到文档
    async insertDirectoryTree(file: TFile) {
        // 获取用户输入的路径
        const pathInput = await this.getPathFromUser();
        if (!pathInput) return;

        const targetPath = pathInput.trim();
        
        // 验证路径
        const validationResult = this.validatePath(targetPath);
        if (!validationResult.isValid) {
            new Notice(`路径无效: ${validationResult.error}`);
            return;
        }

        // 生成树结构
        new Notice('正在扫描目录，请稍候...');
        const tree = await this.generateTree(targetPath);
        
        if (!tree || tree.children.length === 0) {
            new Notice('该目录下没有找到任何文件或文件夹');
            return;
        }

        // 格式化为树形文本
        const treeText = this.formatTreeAsText(tree);
        
        // 插入到文档
        await this.insertIntoDocument(file, treeText, targetPath);
        
        new Notice('目录树已成功插入到文档');
    }

    // 获取用户输入的路径
    async getPathFromUser(): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new PathInputModal(this.app, (result) => {
                resolve(result);
            });
            modal.open();
        });
    }

    // 验证路径是否合法
    validatePath(targetPath: string): { isValid: boolean; error?: string } {
        try {
            // 检查路径是否存在
            if (!fs.existsSync(targetPath)) {
                return { isValid: false, error: '路径不存在' };
            }

            // 检查是否为绝对路径
            const isAbsolute = path.isAbsolute(targetPath);
            if (!isAbsolute) {
                return { isValid: false, error: '请输入绝对路径' };
            }

            // 检查是否为目录
            const stat = fs.statSync(targetPath);
            if (!stat.isDirectory()) {
                return { isValid: false, error: '路径不是一个目录' };
            }

            return { isValid: true };
        } catch (err) {
            return { isValid: false, error: `路径检查失败: ${err.message}` };
        }
    }

    // 生成目录树
    async generateTree(rootPath: string, currentDepth: number = 0, relativePath: string = ''): Promise<TreeNode> {
        const fullPath = path.join(rootPath, relativePath);
        const name = path.basename(fullPath) || rootPath;
        
        const node: TreeNode = {
            name: name,
            path: relativePath || rootPath,
            isFile: false,
            children: []
        };

        // 检查深度限制
        if (this.settings.maxDepth > 0 && currentDepth >= this.settings.maxDepth) {
            return node;
        }

        try {
            const items = await fs.promises.readdir(fullPath);
            
            // 过滤项目
            const filteredItems = this.filterItems(items, fullPath);
            
            // 分别处理文件夹和文件
            const folders: string[] = [];
            const files: string[] = [];
            
            for (const item of filteredItems) {
                const itemPath = path.join(fullPath, item);
                const stat = await fs.promises.stat(itemPath);
                
                if (stat.isDirectory()) {
                    folders.push(item);
                } else {
                    files.push(item);
                }
            }
            
            // 排序：文件夹在前，文件在后，都按字母顺序
            folders.sort((a, b) => a.localeCompare(b));
            files.sort((a, b) => a.localeCompare(b));
            
            // 处理文件夹
            for (const folder of folders) {
                const childRelativePath = relativePath ? path.join(relativePath, folder) : folder;
                const childNode = await this.generateTree(rootPath, currentDepth + 1, childRelativePath);
                node.children.push(childNode);
            }
            
            // 处理文件
            for (const file of files) {
                const filePath = path.join(fullPath, file);
                const stat = await fs.promises.stat(filePath);
                
                node.children.push({
                    name: file,
                    path: relativePath ? path.join(relativePath, file) : file,
                    isFile: true,
                    children: [],
                    size: stat.size
                });
            }
            
        } catch (err) {
            console.error(`读取目录失败: ${fullPath}`, err);
        }
        
        return node;
    }

    // 过滤项目（隐藏文件和排除模式）
    filterItems(items: string[], dirPath: string): string[] {
        const excludeList = this.settings.excludePatterns.split(',').map(p => p.trim()).filter(p => p);
        
        return items.filter(item => {
            // 检查隐藏文件
            if (!this.settings.showHidden && item.startsWith('.')) {
                return false;
            }
            
            // 检查排除模式
            for (const pattern of excludeList) {
                if (item === pattern || item.includes(pattern)) {
                    return false;
                }
            }
            
            return true;
        });
    }

    // 格式化树结构为文本（与批量创建插件兼容的格式）
    formatTreeAsText(node: TreeNode, indentLevel: number = 0): string {
        let result = '';
        
        // 跳过根节点
        if (indentLevel === 0) {
            // 根节点不输出，直接处理子节点
            for (const child of node.children) {
                result += this.formatTreeNode(child, 0);
            }
        }
        
        return result;
    }
    
    formatTreeNode(node: TreeNode, indentLevel: number): string {
        const indent = '\t'.repeat(indentLevel);
        let result = indent + node.name;
        
        // 如果是文件且没有.md后缀，添加提示（可选）
        if (node.isFile && !node.name.endsWith('.md')) {
            // 保持原样，让用户自己决定
        }
        
        result += '\n';
        
        // 递归处理子节点
        for (const child of node.children) {
            result += this.formatTreeNode(child, indentLevel + 1);
        }
        
        return result;
    }

    // 插入内容到文档
    async insertIntoDocument(file: TFile, treeText: string, sourcePath: string) {
        // 获取当前编辑器
        // const editor = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView)?.editor;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        if (!editor) {
            new Notice('无法获取编辑器实例');
            return;
        }
        
        // 生成要插入的内容
        const header = `## 目录树: ${sourcePath}\n\n`;
        const footer = `\n\n*生成时间: ${new Date().toLocaleString()}*\n`;
        const content = header + '```\n' + treeText.trim() + '\n```' + footer;
        
        // 获取当前光标位置
        const cursor = editor.getCursor();
        
        // 插入内容
        editor.replaceRange(content, cursor);
        
        // 可选：将光标移动到插入内容的末尾
        const newCursor = {
            line: cursor.line + content.split('\n').length,
            ch: 0
        };
        editor.setCursor(newCursor);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// 路径输入模态框
class PathInputModal extends Modal {
    private onSubmit: (result: string | null) => void;
    private inputEl: HTMLInputElement;

    constructor(app: App, onSubmit: (result: string | null) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: '输入目录路径' });
        contentEl.createEl('p', { 
            text: '请输入要生成目录树的绝对路径（例如：D:/Projects 或 /home/user/Documents）',
            cls: 'mod-warning'
        });
        
        // 创建输入框
        const inputDiv = contentEl.createDiv();
        this.inputEl = inputDiv.createEl('input', {
            type: 'text',
            placeholder: '请输入绝对路径...',
            cls: 'path-input'
        });
        this.inputEl.style.width = '100%';
        this.inputEl.style.marginBottom = '10px';
        
        // 创建按钮容器
        const buttonDiv = contentEl.createDiv();
        buttonDiv.style.display = 'flex';
        buttonDiv.style.gap = '10px';
        buttonDiv.style.marginTop = '10px';
        
        // 确认按钮
        const confirmBtn = buttonDiv.createEl('button', { text: '确认' });
        confirmBtn.style.flex = '1';
        confirmBtn.addEventListener('click', () => {
            const value = this.inputEl.value;
            this.close();
            this.onSubmit(value);
        });
        
        // 取消按钮
        const cancelBtn = buttonDiv.createEl('button', { text: '取消' });
        cancelBtn.style.flex = '1';
        cancelBtn.addEventListener('click', () => {
            this.close();
            this.onSubmit(null);
        });
        
        // 回车键提交
        this.inputEl.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                confirmBtn.click();
            }
        });
        
        // 自动聚焦
        this.inputEl.focus();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 设置选项卡类
class TreeGeneratorSettingTab extends PluginSettingTab {
    plugin: TreeGeneratorPlugin;

    constructor(app: App, plugin: TreeGeneratorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: '目录树生成器设置' });

        // 操作系统类型选择
        new Setting(containerEl)
            .setName('操作系统类型')
            .setDesc('选择当前使用的操作系统，用于路径验证')
            .addDropdown(dropdown => dropdown
                .addOption('windows', 'Windows')
                .addOption('linux', 'Linux / macOS')
                .setValue(this.plugin.settings.osType)
                .onChange(async (value: 'windows' | 'linux') => {
                    this.plugin.settings.osType = value;
                    await this.plugin.saveSettings();
                }));

        // 最大深度设置
        new Setting(containerEl)
            .setName('最大深度')
            .setDesc('目录树的最大深度（0表示无限制）')
            .addSlider(slider => slider
                .setLimits(0, 10, 1)
                .setValue(this.plugin.settings.maxDepth)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxDepth = value;
                    await this.plugin.saveSettings();
                }))
            .addText(text => {
                text.setValue(this.plugin.settings.maxDepth.toString())
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num >= 0 && num <= 10) {
                            this.plugin.settings.maxDepth = num;
                            await this.plugin.saveSettings();
                        }
                    });
                text.inputEl.style.width = '60px';
            });

        // 显示隐藏文件
        new Setting(containerEl)
            .setName('显示隐藏文件')
            .setDesc('是否显示以点(.)开头的隐藏文件和文件夹')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showHidden)
                .onChange(async (value) => {
                    this.plugin.settings.showHidden = value;
                    await this.plugin.saveSettings();
                }));

        // 排除模式
        new Setting(containerEl)
            .setName('排除模式')
            .setDesc('要排除的文件夹或文件名称（用逗号分隔），例如: node_modules,.git,dist')
            .addTextArea(text => {
                text.setPlaceholder('node_modules, .git, dist, build')
                    .setValue(this.plugin.settings.excludePatterns)
                    .onChange(async (value) => {
                        this.plugin.settings.excludePatterns = value;
                        await this.plugin.saveSettings();
                    });
                
                text.inputEl.style.width = '100%';
                text.inputEl.style.height = '100px';
                text.inputEl.style.resize = 'vertical';
            });
    }
}

// 导入 Modal 类
import { Modal } from 'obsidian';