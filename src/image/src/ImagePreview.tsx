import type { ExtractPublicPropTypes, MaybeArray } from '../../_utils'
import type { ImagePreviewInst } from './public-types'
import { off, on } from 'evtd'
import { kebabCase } from 'lodash-es'
import { beforeNextFrameOnce } from 'seemly'
import { zindexable } from 'vdirs'
import { useIsMounted, useMergedState } from 'vooks'
import {
  computed,
  type CSSProperties,
  defineComponent,
  Fragment,
  h,
  inject,
  normalizeStyle,
  onBeforeUnmount,
  type PropType,
  ref,
  toRef,
  toRefs,
  Transition,
  type VNode,
  vShow,
  watch,
  withDirectives
} from 'vue'
import { LazyTeleport } from 'vueuc'
import { NBaseIcon } from '../../_internal'
import {
  DownloadIcon,
  ResizeSmallIcon,
  RotateClockwiseIcon,
  RotateCounterclockwiseIcon,
  ZoomInIcon,
  ZoomOutIcon
} from '../../_internal/icons'
import { useConfig, useLocale, useTheme, useThemeClass } from '../../_mixins'
import { call, download } from '../../_utils'
import { NTooltip } from '../../tooltip'
import { imageLight } from '../styles'
import { renderCloseIcon, renderNextIcon, renderPrevIcon } from './icons'
import {
  imageContextKey,
  imagePreviewSharedProps,
  type MoveStrategy
} from './interface'
import style from './styles/index.cssr'

const BLEEDING = 32

export const imagePreviewProps = {
  ...imagePreviewSharedProps,
  src: {
    type: String
  },
  show: {
    type: Boolean,
    default: undefined
  },
  defaultShow: {
    type: Boolean,
    default: false
  },
  'onUpdate:show': [Function, Array] as PropType<
    MaybeArray<(value: boolean) => void>
  >,
  onUpdateShow: [Function, Array] as PropType<
    MaybeArray<(show: boolean) => void>
  >,
  onNext: Function as PropType<() => void>,
  onPrev: Function as PropType<() => void>,
  onClose: [Function, Array] as PropType<MaybeArray<() => void>>
}

export type ImagePreviewProps = ExtractPublicPropTypes<typeof imagePreviewProps>

export default defineComponent({
  name: 'ImagePreview',
  props: imagePreviewProps,
  setup(props) {
    const { src } = toRefs(props)

    const { mergedClsPrefixRef } = useConfig(props)
    const themeRef = useTheme(
      'Image',
      '-image',
      style,
      imageLight,
      props,
      mergedClsPrefixRef
    )
    let thumbnailEl: HTMLImageElement | null = null
    const previewRef = ref<HTMLImageElement | null>(null)
    const previewWrapperRef = ref<HTMLDivElement | null>(null)

    const displayedRef = ref(false)
    const { localeRef } = useLocale('Image')

    const uncontrolledShowRef = ref(props.defaultShow)
    const controlledShowRef = toRef(props, 'show')
    const mergedShowRef = useMergedState(controlledShowRef, uncontrolledShowRef)

    function syncTransformOrigin(): void {
      const { value: previewWrapper } = previewWrapperRef
      if (!thumbnailEl || !previewWrapper)
        return
      const { style } = previewWrapper
      const tbox = thumbnailEl.getBoundingClientRect()
      const tx = tbox.left + tbox.width / 2
      const ty = tbox.top + tbox.height / 2

      style.transformOrigin = `${tx}px ${ty}px`
    }

    function handleKeydown(e: KeyboardEvent): void {
      switch (e.key) {
        case ' ':
          e.preventDefault()
          break
        case 'ArrowLeft':
          props.onPrev?.()
          break
        case 'ArrowRight':
          props.onNext?.()
          break
        case 'ArrowUp':
          e.preventDefault()
          zoomIn()
          break
        case 'ArrowDown':
          e.preventDefault()
          zoomOut()
          break
        case 'Escape':
          close()
          break
      }
    }

    function doUpdateShow(value: boolean): void {
      const { onUpdateShow, 'onUpdate:show': _onUpdateShow } = props
      if (onUpdateShow) {
        call(onUpdateShow, value)
      }
      if (_onUpdateShow) {
        call(_onUpdateShow, value)
      }
      uncontrolledShowRef.value = value
      displayedRef.value = true
    }

    watch(mergedShowRef, (value) => {
      if (value) {
        doUpdateShow(true)
        on('keydown', document, handleKeydown)
      }
      else {
        off('keydown', document, handleKeydown)
      }
    })

    onBeforeUnmount(() => {
      off('keydown', document, handleKeydown)
    })

    let startX = 0
    let startY = 0
    let offsetX = 0
    let offsetY = 0
    let startOffsetX = 0
    let startOffsetY = 0
    let mouseDownClientX = 0
    let mouseDownClientY = 0

    let dragging = false

    function handleMouseMove(e: MouseEvent): void {
      const { clientX, clientY } = e
      offsetX = clientX - startX
      offsetY = clientY - startY
      beforeNextFrameOnce(derivePreviewStyle)
    }

    function getMoveStrategy(opts: {
      mouseUpClientX: number
      mouseUpClientY: number
      mouseDownClientX: number
      mouseDownClientY: number
    }): MoveStrategy {
      const {
        mouseUpClientX,
        mouseUpClientY,
        mouseDownClientX,
        mouseDownClientY
      } = opts
      const deltaHorizontal = mouseDownClientX - mouseUpClientX
      const deltaVertical = mouseDownClientY - mouseUpClientY
      const moveVerticalDirection: 'verticalTop' | 'verticalBottom'
        = `vertical${deltaVertical > 0 ? 'Top' : 'Bottom'}`
      const moveHorizontalDirection: 'horizontalLeft' | 'horizontalRight'
        = `horizontal${deltaHorizontal > 0 ? 'Left' : 'Right'}`

      return {
        moveVerticalDirection,
        moveHorizontalDirection,
        deltaHorizontal,
        deltaVertical
      }
    }

    // avoid image move outside viewport
    function getDerivedOffset(moveStrategy?: MoveStrategy): {
      offsetX: number
      offsetY: number
    } {
      const { value: preview } = previewRef
      if (!preview)
        return { offsetX: 0, offsetY: 0 }
      const pbox = preview.getBoundingClientRect()
      const {
        moveVerticalDirection,
        moveHorizontalDirection,
        deltaHorizontal,
        deltaVertical
      } = moveStrategy || {}

      let nextOffsetX = 0
      let nextOffsetY = 0
      if (pbox.width <= window.innerWidth) {
        nextOffsetX = 0
      }
      else if (pbox.left > 0) {
        nextOffsetX = (pbox.width - window.innerWidth) / 2
      }
      else if (pbox.right < window.innerWidth) {
        nextOffsetX = -(pbox.width - window.innerWidth) / 2
      }
      else if (moveHorizontalDirection === 'horizontalRight') {
        nextOffsetX = Math.min(
          (pbox.width - window.innerWidth) / 2,
          startOffsetX - (deltaHorizontal ?? 0)
        )
      }
      else {
        nextOffsetX = Math.max(
          -((pbox.width - window.innerWidth) / 2),
          startOffsetX - (deltaHorizontal ?? 0)
        )
      }

      if (pbox.height <= window.innerHeight) {
        nextOffsetY = 0
      }
      else if (pbox.top > 0) {
        nextOffsetY = (pbox.height - window.innerHeight) / 2
      }
      else if (pbox.bottom < window.innerHeight) {
        nextOffsetY = -(pbox.height - window.innerHeight) / 2
      }
      else if (moveVerticalDirection === 'verticalBottom') {
        nextOffsetY = Math.min(
          (pbox.height - window.innerHeight) / 2,
          startOffsetY - (deltaVertical ?? 0)
        )
      }
      else {
        nextOffsetY = Math.max(
          -((pbox.height - window.innerHeight) / 2),
          startOffsetY - (deltaVertical ?? 0)
        )
      }

      return {
        offsetX: nextOffsetX,
        offsetY: nextOffsetY
      }
    }
    function handleMouseUp(e: MouseEvent): void {
      off('mousemove', document, handleMouseMove)
      off('mouseup', document, handleMouseUp)
      const { clientX: mouseUpClientX, clientY: mouseUpClientY } = e
      dragging = false
      const moveStrategy = getMoveStrategy({
        mouseUpClientX,
        mouseUpClientY,
        mouseDownClientX,
        mouseDownClientY
      })
      const offset = getDerivedOffset(moveStrategy)
      offsetX = offset.offsetX
      offsetY = offset.offsetY
      derivePreviewStyle()
    }
    const imageContext = inject(imageContextKey, null)

    function handlePreviewMousedown(e: MouseEvent): void {
      imageContext?.previewedImgPropsRef.value?.onMousedown?.(e)
      if (e.button !== 0)
        return

      const { clientX, clientY } = e
      dragging = true
      startX = clientX - offsetX
      startY = clientY - offsetY
      startOffsetX = offsetX
      startOffsetY = offsetY

      mouseDownClientX = clientX
      mouseDownClientY = clientY

      derivePreviewStyle()
      on('mousemove', document, handleMouseMove)
      on('mouseup', document, handleMouseUp)
    }

    const scaleRadix = 1.5
    let scaleExp = 0
    let scale = 1
    let rotate = 0
    function handlePreviewDblclick(e: MouseEvent): void {
      imageContext?.previewedImgPropsRef.value?.onDblclick?.(e)
      const originalImageSizeScale = getOrignalImageSizeScale()
      scale = scale === originalImageSizeScale ? 1 : originalImageSizeScale
      derivePreviewStyle()
    }
    function resetScale(): void {
      scale = 1
      scaleExp = 0
    }
    function handleSwitchPrev(): void {
      resetScale()
      rotate = 0
      props.onPrev?.()
    }
    function handleSwitchNext(): void {
      resetScale()
      rotate = 0
      props.onNext?.()
    }
    function rotateCounterclockwise(): void {
      rotate -= 90
      derivePreviewStyle()
    }
    function rotateClockwise(): void {
      rotate += 90
      derivePreviewStyle()
    }
    function getMaxScale(): number {
      const { value: preview } = previewRef
      if (!preview)
        return 1
      const { innerWidth, innerHeight } = window
      const heightMaxScale = Math.max(
        1,
        preview.naturalHeight / (innerHeight - BLEEDING)
      )
      const widthMaxScale = Math.max(
        1,
        preview.naturalWidth / (innerWidth - BLEEDING)
      )
      return Math.max(3, heightMaxScale * 2, widthMaxScale * 2)
    }
    function getOrignalImageSizeScale(): number {
      const { value: preview } = previewRef
      if (!preview)
        return 1
      const { innerWidth, innerHeight } = window
      const heightScale = preview.naturalHeight / (innerHeight - BLEEDING)
      const widthScale = preview.naturalWidth / (innerWidth - BLEEDING)
      if (heightScale < 1 && widthScale < 1) {
        return 1
      }
      return Math.max(heightScale, widthScale)
    }

    function zoomIn(): void {
      const maxScale = getMaxScale()
      if (scale < maxScale) {
        scaleExp += 1
        scale = Math.min(maxScale, scaleRadix ** scaleExp)
        derivePreviewStyle()
      }
    }
    function zoomOut(): void {
      if (scale > 0.5) {
        const originalScale = scale
        scaleExp -= 1
        scale = Math.max(0.5, scaleRadix ** scaleExp)
        const diff = originalScale - scale
        derivePreviewStyle(false)
        const offset = getDerivedOffset()
        scale += diff
        derivePreviewStyle(false)
        scale -= diff
        offsetX = offset.offsetX
        offsetY = offset.offsetY
        derivePreviewStyle()
      }
    }

    function handleDownloadClick(): void {
      const imgSrc = src.value
      if (imgSrc) {
        download(imgSrc, undefined)
      }
    }

    function derivePreviewStyle(transition: boolean = true): void {
      const { value: preview } = previewRef
      if (!preview)
        return
      const { style } = preview
      const controlledStyle = normalizeStyle(
        imageContext?.previewedImgPropsRef.value?.style
      )
      let controlledStyleString = ''
      if (typeof controlledStyle === 'string') {
        controlledStyleString = `${controlledStyle};`
      }
      else {
        for (const key in controlledStyle) {
          controlledStyleString += `${kebabCase(key)}: ${controlledStyle[key]};`
        }
      }
      const transformStyle = `transform-origin: center; transform: translateX(${offsetX}px) translateY(${offsetY}px) rotate(${rotate}deg) scale(${scale});`
      if (dragging) {
        style.cssText = `${
          controlledStyleString
        }cursor: grabbing; transition: none;${transformStyle}`
      }
      else {
        style.cssText = `${controlledStyleString}cursor: grab;${
          transformStyle
        }${transition ? '' : 'transition: none;'}`
      }
      if (!transition) {
        void preview.offsetHeight
      }
    }

    function close() {
      if (mergedShowRef.value) {
        const { onClose } = props
        if (onClose)
          call(onClose)
        doUpdateShow(false)
        uncontrolledShowRef.value = false
      }
    }

    function resizeToOrignalImageSize(): void {
      scale = getOrignalImageSizeScale()
      scaleExp = Math.ceil(Math.log(scale) / Math.log(scaleRadix))
      offsetX = 0
      offsetY = 0
      derivePreviewStyle()
    }
    const exposedMethods: ImagePreviewInst = {
      setThumbnailEl: (el) => {
        thumbnailEl = el
      }
    }

    function withTooltip(
      node: VNode,
      tooltipKey: keyof typeof localeRef.value
    ): VNode {
      if (props.showToolbarTooltip) {
        const { value: theme } = themeRef
        return (
          <NTooltip
            to={false}
            theme={theme.peers.Tooltip}
            themeOverrides={theme.peerOverrides.Tooltip}
            keepAliveOnHover={false}
          >
            {{
              default: () => {
                return localeRef.value[tooltipKey]
              },
              trigger: () => node
            }}
          </NTooltip>
        )
      }
      else {
        return node
      }
    }

    const cssVarsRef = computed(() => {
      const {
        common: { cubicBezierEaseInOut },
        self: {
          toolbarIconColor,
          toolbarBorderRadius,
          toolbarBoxShadow,
          toolbarColor
        }
      } = themeRef.value
      return {
        '--n-bezier': cubicBezierEaseInOut,
        '--n-toolbar-icon-color': toolbarIconColor,
        '--n-toolbar-color': toolbarColor,
        '--n-toolbar-border-radius': toolbarBorderRadius,
        '--n-toolbar-box-shadow': toolbarBoxShadow
      }
    })

    const { inlineThemeDisabled } = useConfig()

    const themeClassHandle = inlineThemeDisabled
      ? useThemeClass('image-preview', undefined, cssVarsRef, props)
      : undefined

    function handleWheel(event: WheelEvent) {
      event.preventDefault()
    }

    return {
      clsPrefix: mergedClsPrefixRef,
      previewRef,
      previewWrapperRef,
      previewSrc: src,
      mergedShow: mergedShowRef,
      appear: useIsMounted(),
      displayed: displayedRef,
      previewedImgProps: imageContext?.previewedImgPropsRef,
      handleWheel,
      handlePreviewMousedown,
      handlePreviewDblclick,
      syncTransformOrigin,
      handleAfterLeave: () => {
        resetScale()
        rotate = 0
        displayedRef.value = false
      },
      handleDragStart: (e: DragEvent) => {
        imageContext?.previewedImgPropsRef.value?.onDragstart?.(e)
        e.preventDefault()
      },
      zoomIn,
      zoomOut,
      handleDownloadClick,
      rotateCounterclockwise,
      rotateClockwise,
      handleSwitchPrev,
      handleSwitchNext,
      withTooltip,
      resizeToOrignalImageSize,
      cssVars: inlineThemeDisabled ? undefined : cssVarsRef,
      themeClass: themeClassHandle?.themeClass,
      onRender: themeClassHandle?.onRender,
      doUpdateShow,
      close,
      ...exposedMethods
    }
  },
  render() {
    const { clsPrefix, renderToolbar, withTooltip } = this

    const prevNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.handleSwitchPrev}>
        {{ default: renderPrevIcon }}
      </NBaseIcon>,
      'tipPrevious'
    )
    const nextNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.handleSwitchNext}>
        {{ default: renderNextIcon }}
      </NBaseIcon>,
      'tipNext'
    )

    const rotateCounterclockwiseNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.rotateCounterclockwise}>
        {{
          default: () => <RotateCounterclockwiseIcon />
        }}
      </NBaseIcon>,
      'tipCounterclockwise'
    )
    const rotateClockwiseNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.rotateClockwise}>
        {{
          default: () => <RotateClockwiseIcon />
        }}
      </NBaseIcon>,
      'tipClockwise'
    )
    const originalSizeNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.resizeToOrignalImageSize}>
        {{
          default: () => {
            return <ResizeSmallIcon />
          }
        }}
      </NBaseIcon>,
      'tipOriginalSize'
    )
    const zoomOutNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.zoomOut}>
        {{ default: () => <ZoomOutIcon /> }}
      </NBaseIcon>,
      'tipZoomOut'
    )

    const downloadNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.handleDownloadClick}>
        {{ default: () => <DownloadIcon /> }}
      </NBaseIcon>,
      'tipDownload'
    )

    const closeNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={() => this.close()}>
        {{ default: renderCloseIcon }}
      </NBaseIcon>,
      'tipClose'
    )

    const zoomInNode = withTooltip(
      <NBaseIcon clsPrefix={clsPrefix} onClick={this.zoomIn}>
        {{ default: () => <ZoomInIcon /> }}
      </NBaseIcon>,
      'tipZoomIn'
    )

    return (
      <>
        {this.$slots.default?.()}
        <LazyTeleport show={this.mergedShow}>
          {{
            default: () => {
              if (!(this.mergedShow || this.displayed)) {
                return null
              }
              this.onRender?.()
              return withDirectives(
                <div
                  ref="containerRef"
                  class={[
                    `${clsPrefix}-image-preview-container`,
                    this.themeClass
                  ]}
                  style={this.cssVars as CSSProperties}
                  onWheel={this.handleWheel}
                >
                  <Transition name="fade-in-transition" appear={this.appear}>
                    {{
                      default: () =>
                        this.mergedShow ? (
                          <div
                            class={`${clsPrefix}-image-preview-overlay`}
                            onClick={() => this.close()}
                          />
                        ) : null
                    }}
                  </Transition>
                  {this.showToolbar ? (
                    <Transition name="fade-in-transition" appear={this.appear}>
                      {{
                        default: () => {
                          if (!this.mergedShow)
                            return null
                          return (
                            <div class={`${clsPrefix}-image-preview-toolbar`}>
                              {renderToolbar ? (
                                renderToolbar({
                                  nodes: {
                                    prev: prevNode,
                                    next: nextNode,
                                    rotateCounterclockwise:
                                      rotateCounterclockwiseNode,
                                    rotateClockwise: rotateClockwiseNode,
                                    resizeToOriginalSize: originalSizeNode,
                                    zoomOut: zoomOutNode,
                                    zoomIn: zoomInNode,
                                    download: downloadNode,
                                    close: closeNode
                                  }
                                })
                              ) : (
                                <>
                                  {this.onPrev ? (
                                    <>
                                      {prevNode}
                                      {nextNode}
                                    </>
                                  ) : null}
                                  {rotateCounterclockwiseNode}
                                  {rotateClockwiseNode}
                                  {originalSizeNode}
                                  {zoomOutNode}
                                  {zoomInNode}
                                  {downloadNode}
                                  {closeNode}
                                </>
                              )}
                            </div>
                          )
                        }
                      }}
                    </Transition>
                  ) : null}
                  <Transition
                    name="fade-in-scale-up-transition"
                    onAfterLeave={this.handleAfterLeave}
                    appear={this.appear}
                    // BUG:
                    // onEnter will be called twice, I don't know why
                    // Maybe it is a bug of vue
                    onEnter={this.syncTransformOrigin}
                    onBeforeLeave={this.syncTransformOrigin}
                  >
                    {{
                      default: () => {
                        const { previewedImgProps = {} } = this
                        return withDirectives(
                          <div
                            class={`${clsPrefix}-image-preview-wrapper`}
                            ref="previewWrapperRef"
                          >
                            <img
                              {...previewedImgProps}
                              draggable={false}
                              onMousedown={this.handlePreviewMousedown}
                              onDblclick={this.handlePreviewDblclick}
                              class={[
                                `${clsPrefix}-image-preview`,
                                previewedImgProps.class
                              ]}
                              key={this.previewSrc}
                              src={this.previewSrc}
                              ref="previewRef"
                              onDragstart={this.handleDragStart}
                            />
                          </div>,
                          [[vShow, this.mergedShow]]
                        )
                      }
                    }}
                  </Transition>
                </div>,
                [[zindexable, { enabled: this.mergedShow }]]
              )
            }
          }}
        </LazyTeleport>
      </>
    )
  }
})
