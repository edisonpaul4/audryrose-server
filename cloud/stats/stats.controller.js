const { ProductsModel } = require('../products/products.model');
const { ReturnsModel } = require('../returns/returns.model');
const { OrdersModel } = require('../orders/orders.model');
const { DesignersModel } = require('../designers/designers.model')
var _ = require('underscore');

var moment = require('moment-timezone');

exports.StatsController = new class StatsCrontroller {
  constructor() { }

  getProductStats() {
    console.log('entra');
    var productsOut;
    var response = ProductsModel.getProductsByFilters({
      limit: 10000
    }).find().then(products => {
      //return OrdersModel.getOrderProductsByFilters(
      //  { limit: 10000,greaterOrEqual: [{ key: 'createdAt', value: moment('20180128').toDate() }] }).find().then(productOrders => {
      console.log('done order product')
      return ReturnsModel.getReturnsByFilters({ limit: 100000 }).find().then(productReturns => {
        console.log('done return')
        return Promise.all(products.map(product => this.createProductStatsObject(product, null, productReturns)))
      })
      //  });
    });
    return (response);
  }

  createProductStatsObject(productObject, productOrders, productReturns) {
    var countingSold = 0;
    var filteredReturns = productReturns.filter(result => result.get('productId') == productObject.get('productId'));
    var countingReturn = filteredReturns.filter(result => result.get('returnTypeId') == 0).length;
    var countingRepair = filteredReturns.filter(result => result.get('returnTypeId') == 1).length;
    // _.filter(productOrders,result => result.get('product_id') == productObject.get('productId')).map(result => countingSold += result.get('quantity'))

    return OrdersModel.getOrderProductsByFilters(
      { limit: 10000, equal: [{ key: 'product_id', value: productObject.get('productId') }] }).find().then(productOrders => {
        productOrders.map(result => countingSold += result.get('quantity'))
        return {
          productId: productObject.get('productId'),
          productName: productObject.get('name'),
          totalSold: countingSold,
          unitsReturned: countingReturn,
          unitsReturnedP: countingSold !== 0 ? (countingReturn * 100) / countingSold : 0,
          unitsRepaired: countingRepair,
          unitsRepairedP: countingSold !== 0 ? (countingRepair * 100) / countingSold : 0,
          totalReveneu: productObject.get('price') * countingSold
        };
      })
  }

  async getDesignerStats() {
    let designers = await DesignersModel.getDesigners({limit: 1000}).find().then(designers => designers.map(designer => designer.toJSON()));
    let productsAndDesigners = await ProductsModel.getProductsByFilters({limit: 10000, includes: ['designer']}).find().then(products => products.map(function(product) {
      product = product.toJSON();
      return {
        productId : product.productId,
        designer : product.designer
      }
    }));

    //Get vendor orders
    let params = {
      includes: ['vendorOrderVariants', 'vendorOrderVariants.variant', 'vendorOrderVariants.variant.designer'],
      limit: 10000
    }
    let vendorOrders = await DesignersModel.getVendorOrdersByFilters(params).find().then(vendorOrders => vendorOrders.map(vendorOrder => vendorOrder.toJSON()));


    let result = [];

    for (let i=0; i<designers.length; i++) {
      let designer = designers[i];

      //get all the products from this designer
      let productsFromDesigner = productsAndDesigners.filter(function(product){
        if (product.designer && product.designer.objectId == designer.objectId) {
          return true;
        }
        return false;
      })


      //we have the products from this designer now. Get all the orders from this designer
      let productIds = productsFromDesigner.map(product => product.productId);
      let ordersFromDesigner = await OrdersModel.getOrderProductsByFilters({limit:100000, contained: [{key: 'product_id', value: productIds}]}).find().then(ordersFromDesigner => ordersFromDesigner.map(order => order.toJSON()));

      //calculate the values
      let countingSold = 0;
      let countingLastThreeMonths = 0;
      let countingLastTwoMonths = 0;
      let dateThreeMonths = new Date();
      let dateTwoMonths = new Date();
      let today = new Date();
      dateThreeMonths.setMonth(dateThreeMonths.getMonth() - 3);
      dateTwoMonths.setMonth(dateTwoMonths.getMonth()-2);
      let revenue = 0;


      ordersFromDesigner.map(function(order){
        countingSold += order.quantity;
        revenue += order.base_price * order.quantity;

        let orderDate = new Date (order.createdAt);

        if (orderDate.getTime() >= dateThreeMonths.getTime()) {
          countingLastThreeMonths += order.quantity;
        }

        if (orderDate.getTime() >= dateTwoMonths.getTime()) {
          countingLastTwoMonths += order.quantity;
        }

      })

      let averageOrderValue = countingSold !== 0 ? revenue / countingSold : 0;

      //Check returns and repairs
      let returnedOrders = await ReturnsModel.getReturnsByFilters({contained: [{key: 'orderProductId', value: ordersFromDesigner.map(order => order.orderProductId)}]}).find();
      let countingReturn = returnedOrders.filter(result => result.get('returnTypeId') == 0).length;
      let countingRepair = returnedOrders.filter(result => result.get('returnTypeId') == 1).length;

      let returnRate = countingSold !== 0 ? (countingReturn * 100) / countingSold : 0;
      let repairRate = countingSold !== 0 ? (countingRepair * 100) / countingSold : 0;

      //check vendor orders

      let vendorOrdersFromDesigner = vendorOrders.filter(function(vendorOrder){
        if (vendorOrder.vendorOrderVariants.length == 0 || (vendorOrder.vendorOrderVariants[0]).variant.designer.designerId !== designer.designerId) {
          return false;
        }
       return true;
     });

     //Calculate the values related to inventory
     let date = new Date();
     let dateThisMonth = new Date(date.getFullYear(), date.getMonth(), 1);


     //All the items ordered the last month
     let orderedLastMonth = vendorOrdersFromDesigner.filter(function (vendorOrder){
       if (!vendorOrder.dateOrdered) { return false; }
       let orderDate = new Date(vendorOrder.dateOrdered.iso);
       if (orderDate.getTime() >= dateThisMonth.getTime()) {
         return true;
       }
       return false;
     })

     let sumPriceVendorOrdersthisMonth = 0;
     orderedLastMonth.map (function (vendorOrder){
       vendorOrder.vendorOrderVariants.map(function(variant){
         if (variant.variant.adjustedWholesalePrice) {
           sumPriceVendorOrdersthisMonth += variant.variant.adjustedWholesalePrice;
         }
         return variant;
       })
       return vendorOrder;
     })

     //All the items checked in this month

     let checkedInLastMonth = vendorOrdersFromDesigner.filter(function (vendorOrder){
       if (!vendorOrder.dateReceived) { return false; }
       let receivedDate = new Date(vendorOrder.dateReceived.iso);
       if (receivedDate.getTime() >= dateThisMonth.getTime()) {
         return true;
       }
       return false;
     })

     let sumPriceCheckedInThisMonth = 0;
     checkedInLastMonth.map (function (vendorOrder){
       vendorOrder.vendorOrderVariants.map(function(variant){
         if (variant.variant.adjustedWholesalePrice) {
           sumPriceCheckedInThisMonth += variant.variant.adjustedWholesalePrice;
         }
         return variant;
       })
       return vendorOrder;
     })

     //All the items pending from vendors
     let pendingVendorOrder = vendorOrdersFromDesigner.filter(function (vendorOrder){
       if (!vendorOrder.receivedAll) {
         return true;
       }
       return false;
     })

     let pendingAmount = 0;

     pendingVendorOrder.map(function(vendorOrder){
       vendorOrder.vendorOrderVariants.map(function(variant){
         if (variant.units && variant.received && variant.units > variant.received && variant.variant.adjustedWholesalePrice) {
           let quantity = variant.units - variant.received;
           pendingAmount += quantity * variant.variant.adjustedWholesalePrice;
         }
         return variant;
       })
       return vendorOrder;
     })

      //save the result
      result.push({
        designerId: designer.designerId,
        designerName: designer.name,
        sales: countingSold,
        revenue: revenue,
        aov: averageOrderValue,
        repairedP: repairRate,
        returnedP: returnRate,
        sumPriceVendorOrdersthisMonth : sumPriceVendorOrdersthisMonth,
        sumPriceCheckedInthisMonth : sumPriceCheckedInThisMonth,
        inventoryPending : pendingAmount
      })
    }

    return (result);
  }


}
