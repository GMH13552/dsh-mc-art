package com.examplemod;

import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.event.RegisterGameTestsEvent;
import net.minecraftforge.gametest.PrefixGameTestTemplate;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.registries.ForgeRegistries;

/**
 * 这个模组的裁判。
 *
 * <p>它跑在 {@code GameTestServer} 里——Mojang 自带的那种**无窗口专用服务端**：
 * 跑完注册的测试就退出，**退出码就是失败的必要测试数量**。所以"做完了没有"
 * 不是我说了算，是这个数字说了算。
 *
 * <p>注册方式用的是 Forge 自己在 1.18.x 里用的那条：
 * {@link RegisterGameTestsEvent} 挂在 mod 事件总线上，把整个类交上去
 * （MinecraftForge 1.18.x 的 {@code src/test/java/.../GameTestTest.java} 就是这么写的）。
 */
@Mod.EventBusSubscriber(modid = ExampleMod.MODID, bus = Mod.EventBusSubscriber.Bus.MOD)
public final class ExampleGameTests {
    private ExampleGameTests() {
    }

    @SubscribeEvent
    public static void onRegisterGameTests(RegisterGameTestsEvent event) {
        event.register(ExampleGameTests.class);
    }

    /**
     * 方块真的存在，而且真的能放下去。
     *
     * <p>默认模板是**空结构**（没有 templates 文件时），所以这里自己放一块再断言，
     * 这也正是 Forge 示例里 {@code teststone} 那个生成器的写法。
     */
    @PrefixGameTestTemplate(false)
    @GameTest(templateNamespace = ExampleMod.MODID, template = "empty3x3x3")
    public static void exampleBlockPlaces(GameTestHelper helper) {
        BlockPos pos = new BlockPos(1, 1, 1);
        helper.setBlock(pos, ExampleMod.EXAMPLE_BLOCK.get());
        helper.assertBlockState(pos, state -> state.is(ExampleMod.EXAMPLE_BLOCK.get()),
                () -> "放下去的示例方块不是示例方块");
        helper.succeed();
    }

    /**
     * 方块和它的物品**都**叫 {@code examplemod:example_block}，而且互相指着对方。
     *
     * <p>资源和代码对得上全靠这个名字：方块 id 决定 {@code blockstates/} 和
     * {@code models/block/} 去哪找，物品 id 决定 {@code models/item/} 和图标去哪找。
     * 两边名字不一致时游戏**不会报错**，只会有一半资源静默丢进虚空——所以这条要游戏来判。
     *
     * <p>写法上有一处是实测出来的：1.18.2 的 {@code GameTestHelper} **没有**
     * {@code assertTrue}(boolean, String)，只有 {@code fail(String)} / {@code failIf}。
     * 我先按记忆写 `assertTrue`，编译器当场报 `cannot find symbol`（正面证据：
     * `javap -classpath <mapped jar> net.minecraft.gametest.framework.GameTestHelper`）。
     */
    @PrefixGameTestTemplate(false)
    @GameTest(templateNamespace = ExampleMod.MODID, template = "empty3x3x3")
    public static void exampleBlockIsRegisteredUnderItsName(GameTestHelper helper) {
        ResourceLocation blockId = ForgeRegistries.BLOCKS.getKey(ExampleMod.EXAMPLE_BLOCK.get());
        ResourceLocation itemId = ForgeRegistries.ITEMS.getKey(ExampleMod.EXAMPLE_BLOCK_ITEM.get());
        boolean named = blockId != null && itemId != null
                && ExampleMod.MODID.equals(blockId.getNamespace())
                && "example_block".equals(blockId.getPath())
                && blockId.equals(itemId);
        // `getBlock()` 在 BlockItem 上，不在 Item 上（也是实测：javap BlockItem）。
        net.minecraft.world.item.Item item = ExampleMod.EXAMPLE_BLOCK_ITEM.get();
        boolean wired = item instanceof net.minecraft.world.item.BlockItem
                && ((net.minecraft.world.item.BlockItem) item).getBlock() == ExampleMod.EXAMPLE_BLOCK.get();
        if (!named || !wired) {
            helper.fail("注册名不对：block=" + blockId + " item=" + itemId
                    + "（两者必须都是 examplemod:example_block），物品指向方块=" + wired);
        }
        helper.succeed();
    }
}
