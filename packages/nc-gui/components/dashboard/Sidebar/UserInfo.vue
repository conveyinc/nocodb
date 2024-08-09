<script lang="ts" setup>
const { user, signOut, appInfo } = useGlobal()
// So watcher in users store is triggered
useUsers()

const { leftSidebarState } = storeToRefs(useSidebarStore())

const name = computed(() => user.value?.display_name?.trim())

const isMenuOpen = ref(false)

const isAuthTokenCopied = ref(false)

const isLoggingOut = ref(false)

const { isMobileMode } = useGlobal()

const logout = async () => {
  isLoggingOut.value = true
  try {
    const isSsoUser = !!(user?.value as any)?.sso_client_id

    await signOut(false)

    // No need as all stores are cleared on signout
    // await clearWorkspaces()

    await navigateTo(isSsoUser ? '/sso' : '/signin')
  } catch (e) {
    console.error(e)
  } finally {
    isLoggingOut.value = false
  }
}

watch(isMenuOpen, () => {
  if (isAuthTokenCopied.value) {
    isAuthTokenCopied.value = false
  }
})

watch(leftSidebarState, () => {
  if (leftSidebarState.value === 'peekCloseEnd') {
    isMenuOpen.value = false
  }
})

// This is a hack to prevent github button error (prevents navigateTo if user is not signed in)
const isMounted = ref(false)

onMounted(() => {
  isMounted.value = true
})
</script>

<template>
  <div class="flex w-full flex-col py-0.9 px-1 border-gray-200 gap-y-1">
    <LazyGeneralMaintenanceAlert />
    <div class="flex items-center pr-2 justify-between">
      <NcDropdown v-model:visible="isMenuOpen" placement="topLeft" overlay-class-name="!min-w-64">
        <div
          class="flex flex-row py-1 px-3 gap-x-2 items-center hover:bg-gray-200 rounded-lg cursor-pointer h-8"
          data-testid="nc-sidebar-userinfo"
        >
          <GeneralUserIcon :email="user?.email" size="auto" :name="user?.display_name" />
          <NcTooltip>
            <div class="flex max-w-32 truncate">
              {{ name ? name : user?.email }}
            </div>

            <template #title>
              <span>
                {{ name ? name : user?.email }}
              </span>
            </template>
          </NcTooltip>

          <GeneralIcon icon="chevronDown" class="flex-none !min-w-5 transform rotate-180 !text-gray-500" />
        </div>
        <template #overlay>
          <NcMenu data-testid="nc-sidebar-userinfo">
            <template v-if="!isMobileMode">
              <a
                v-e="['c:nocodb:docs-open']"
                href="https://docs.nocodb.com"
                target="_blank"
                class="!underline-transparent"
                rel="noopener"
              >
                <NcMenuItem>
                  <GeneralIcon icon="file" class="menu-icon mt-0.5" />
                  <span class="menu-btn"> {{ $t('title.docs') }} </span>
                </NcMenuItem>
              </a>

              <NcDivider />

              <DashboardSidebarEEMenuOption v-if="isEeUI" />

              <nuxt-link v-e="['c:user:settings']" class="!no-underline" to="/account/profile">
                <NcMenuItem> <GeneralIcon icon="ncSettings" class="menu-icon" /> {{ $t('title.accountSettings') }} </NcMenuItem>
              </nuxt-link>
            </template>

            <NcMenuItem data-testid="nc-sidebar-user-logout" @click="logout">
              <div v-e="['c:user:logout']" class="flex gap-2 items-center">
                <GeneralLoader v-if="isLoggingOut" class="!ml-0.5 !mr-0.5 !max-h-4.5 !-mt-0.5" />
                <GeneralIcon v-else icon="signout" class="menu-icon" />
                <span class="menu-btn"> {{ $t('general.logout') }}</span>
              </div>
            </NcMenuItem>

          </NcMenu>
        </template>
      </NcDropdown>
      <LazyNotificationMenu />
    </div>

  </div>
</template>

<style lang="scss" scoped>
.menu-btn {
  line-height: 1.5;
}
.menu-icon {
  @apply w-4 h-4;
  font-size: 1rem;
}

.social-icon {
  @apply my-0.5 w-4 h-4 stroke-transparent;
  // Make icon black and white
  filter: grayscale(100%);

  // Make icon red on hover
  &:hover {
    filter: grayscale(100%) invert(100%);
  }
}

.social-icon-wrapper {
  .nc-icon {
    @apply mr-0.15;
  }

  &:hover {
    .social-icon {
      filter: none !important;
    }
  }
}
</style>
