import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { WorkerResource, WorkerMessage, WorkerResponse } from '../workers/preloader.worker'

export enum PreloadResourceType {
    VRM = 'VRM',
    VRMA = 'VRMA',
    SPLAT = 'SPLAT',
    UNKNOWN = 'UNKNOWN',
}

export enum PreloaderStatus {
    PENDING = 'pending',
    LOADING = 'loading',
    COMPLETED = 'completed',
    ERROR = 'error',
}

export enum PreloaderEvent {
    PROGRESS = 'progress',
    COMPLETED = 'completed',
    ERROR = 'error',
}

export class PreloadResource {
    private name: string
    private url: string
    private type: PreloadResourceType
    private data: any

    constructor(url: string, name?: string) {
        this.url = url

        // 获取资源名称
        if (!name) {
            this.name = this.url.split('/').pop() ?? ''
        } else {
            this.name = name
        }

        // 判断资源类型
        let extension = this.url.split('.').pop()?.toLowerCase() ?? ''
        switch (extension) {
            case 'vrm':
                this.type = PreloadResourceType.VRM
                break
            case 'vrma':
                this.type = PreloadResourceType.VRMA
                break
            case 'splat':
            case 'ply':
            case 'ksplat':
                this.type = PreloadResourceType.SPLAT
                break
            default:
                this.type = PreloadResourceType.UNKNOWN
                break
        }
    }

    getName() {
        return this.name
    }

    getUrl() {
        return this.url
    }

    getType() {
        return this.type
    }

    getData() {
        return this.data
    }

    setData(data: any) {
        this.data = data
    }

    toWorkerResource(): WorkerResource {
        return {
            name: this.name,
            url: this.url,
            type: this.type,
        }
    }
}

export class Preloader {
    private resources: PreloadResource[]
    private resourcesMap: Map<string, number>
    private status: string
    private gltfLoader: GLTFLoader | null
    private listeners: any
    private worker: Worker | null
    private loadedResourcesCount: number
    private totalResourcesCount: number
    private pendingGLTFLoads: Set<string>
    private workerInitialized: boolean

    constructor() {
        this.resources = []
        this.resourcesMap = new Map()
        this.status = PreloaderStatus.PENDING
        this.gltfLoader = null
        this.worker = null
        this.loadedResourcesCount = 0
        this.totalResourcesCount = 0
        this.pendingGLTFLoads = new Set()
        this.workerInitialized = false
        this.listeners = {
            progress: [],
            completed: [],
            error: [],
        }

        // resources绑定get方法
        Object.defineProperty(this.resources, 'getByName', {
            value: this.getResource.bind(this),
            writable: false,
            enumerable: false,
            configurable: true,
        })
    }

    // 添加资源
    add(resource: PreloadResource) {
        this.resources.push(resource)
        this.resourcesMap.set(resource.getName(), this.resources.length - 1)
    }

    // 添加监听器
    on(type: string, listener: any) {
        if (this.listeners[type]) {
            this.listeners[type].push(listener)
        } else {
            throw new Error('无效事件类型')
        }
    }

    // 挂载GLTFLoader
    bindGLTFLoader(gltfLoader: GLTFLoader) {
        if (this.gltfLoader) {
            throw new Error('已挂载GLTFLoader')
        }

        this.gltfLoader = gltfLoader
    }

    private dispatchEvent(event: any) {
        switch (event.type) {
            case PreloaderEvent.PROGRESS:
                this.listeners.progress.forEach((listener: any) => {
                    listener(event.progress)
                })
                break
            case PreloaderEvent.COMPLETED:
                this.listeners.completed.forEach((listener: any) => {
                    listener(this.resources)
                })
                break
            case PreloaderEvent.ERROR:
                this.listeners.error.forEach((listener: any) => {
                    listener(event.error)
                })
                break
            default:
                throw new Error('无效事件类型')
        }
    }

    /**
     * 检查是否所有资源都已加载完成
     */
    private checkAllResourcesLoaded() {
        // 只有当所有资源都加载完成且没有待处理的 GLTF 加载时才触发完成事件
        if (
            this.loadedResourcesCount === this.totalResourcesCount &&
            this.pendingGLTFLoads.size === 0
        ) {
            this.status = PreloaderStatus.COMPLETED

            // 确保进度更新到 100%
            this.dispatchEvent({
                type: PreloaderEvent.PROGRESS,
                progress: 100,
            })

            // 触发完成事件
            this.dispatchEvent({
                type: PreloaderEvent.COMPLETED,
            })

            // 清理 Worker
            if (this.worker) {
                this.worker.terminate()
                this.worker = null
            }
        }
    }

    /**
     * 使用 GLTFLoader 加载 ArrayBuffer（通过创建临时 Blob URL）
     */
    private loadGLTFFromBuffer(resource: PreloadResource, arrayBuffer: ArrayBuffer): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.gltfLoader) {
                const error = new Error('GLTFLoader未挂载')
                console.error(error)
                reject(error)
                return
            }

            // 从 ArrayBuffer 创建 Blob URL
            const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' })
            const url = URL.createObjectURL(blob)

            // 使用 load 方法加载（这样插件可以正常工作）
            this.gltfLoader.load(
                url,
                (gltf: any) => {
                    // 清理 Blob URL
                    URL.revokeObjectURL(url)
                    resource.setData(gltf)
                    resolve()
                },
                undefined, // onProgress
                (error: unknown) => {
                    // 清理 Blob URL
                    URL.revokeObjectURL(url)
                    const err = error instanceof Error ? error : new Error(String(error))
                    console.error('GLTF loading error:', err)
                    reject(err)
                }
            )
        })
    }

    /**
     * 处理 Worker 消息
     */
    private handleWorkerMessage = async (event: MessageEvent<WorkerResponse>) => {
        const { type, progress, resourceName, data, error } = event.data

        switch (type) {
            case 'PROGRESS':
                if (progress !== undefined) {
                    this.dispatchEvent({
                        type: PreloaderEvent.PROGRESS,
                        progress,
                    })
                }
                break

            case 'RESOURCE_LOADED':
                if (resourceName && data) {
                    const resource = this.getResource(resourceName)
                    if (resource) {
                        // 根据资源类型处理
                        const resourceType = resource.getType()

                        if (
                            resourceType === PreloadResourceType.VRM ||
                            resourceType === PreloadResourceType.VRMA
                        ) {
                            // GLTF 资源需要在主线程加载（使用 Blob URL）
                            this.pendingGLTFLoads.add(resourceName)
                            
                            this.loadGLTFFromBuffer(resource, data)
                                .then(() => {
                                    this.pendingGLTFLoads.delete(resourceName)
                                    this.loadedResourcesCount++
                                    this.checkAllResourcesLoaded()
                                })
                                .catch((err) => {
                                    this.pendingGLTFLoads.delete(resourceName)
                                    this.dispatchEvent({
                                        type: PreloaderEvent.ERROR,
                                        error: err,
                                    })
                                })
                        } else {
                            // 其他资源直接保存 ArrayBuffer
                            resource.setData(data)
                            this.loadedResourcesCount++
                        }
                    }
                }
                break

            case 'ALL_COMPLETED':
                // Worker 已完成所有下载，但可能还有 GLTF 在主线程解析
                this.checkAllResourcesLoaded()
                break

            case 'ERROR':
                this.status = PreloaderStatus.ERROR
                const err = new Error(error || 'Worker error')
                this.dispatchEvent({
                    type: PreloaderEvent.ERROR,
                    error: err,
                })

                // 清理 Worker
                if (this.worker) {
                    this.worker.terminate()
                    this.worker = null
                }
                break

            case 'SIZE_READY':
                this.workerInitialized = true
                
                // Worker 初始化完成，现在可以开始加载了
                if (this.worker) {
                    this.worker.postMessage({
                        type: 'START_LOAD',
                    } as WorkerMessage)
                }
                break

            default:
                console.warn('Unknown worker message type:', type)
        }
    }

    // 开始加载
    async load() {
        // 检查是否已经开始加载
        if (this.status !== PreloaderStatus.PENDING) {
            throw new Error('Preloader状态错误')
        }

        if (this.resources.length === 0) {
            this.status = PreloaderStatus.COMPLETED
            this.dispatchEvent({
                type: PreloaderEvent.COMPLETED,
            })
            return
        }

        try {
            // 创建 Worker
            this.worker = new Worker(
                new URL('../workers/preloader.worker.ts', import.meta.url),
                { type: 'module' }
            )

            this.worker.addEventListener('message', this.handleWorkerMessage)

            this.worker.addEventListener('error', (error) => {
                this.dispatchEvent({
                    type: PreloaderEvent.ERROR,
                    error: new Error('Worker encountered an error'),
                })
            })

            // 更新状态
            this.status = PreloaderStatus.LOADING
            this.loadedResourcesCount = 0
            this.totalResourcesCount = this.resources.length
            this.pendingGLTFLoads.clear()
            this.workerInitialized = false

            // 发送资源列表到 Worker
            const workerResources = this.resources.map(r => r.toWorkerResource())
            this.worker.postMessage({
                type: 'INIT',
                resources: workerResources,
            } as WorkerMessage)

            // 注意：不再立即发送 START_LOAD，等待 SIZE_READY 后再发送
        } catch (error) {
            this.dispatchEvent({
                type: PreloaderEvent.ERROR,
                error: error instanceof Error ? error : new Error(String(error)),
            })
            throw error
        }
    }

    // 获取资源
    getResources() {
        return this.resources
    }

    // 获取指定资源
    getResource(name: string) {
        let index = this.resourcesMap.get(name)
        return index !== undefined ? this.resources[index] : null
    }

    // 清理
    dispose() {
        if (this.worker) {
            this.worker.terminate()
            this.worker = null
        }
    }
}
