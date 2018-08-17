const { ProductsModel } = require('../products/products.model');
const { ReturnsModel } = require('../returns/returns.model');
const { OrdersModel } = require('../orders/orders.model');
const { DesignersModel } = require('../designers/designers.model')
var moment = require('moment');


exports.StatsController = new class StatsCrontroller {
  constructor() {}

  getProductStats() {
    const products = () => ProductsModel.getProductsByFilters({
      limit: 1000000
    }).find();

    return products()
      .then(products => products.map(this.createProductStatsObject));
  }

  createProductStatsObject(productObject) {
    const unitsReturned = typeof productObject.get('totalReturned') !== 'undefined' ? productObject.get('totalReturned') : 0;
    const unitsRepaired = typeof productObject.get('totalRepaired') !== 'undefined' ? productObject.get('totalRepaired') : 0;
    return {
      productId: productObject.get('productId'),
      productName: productObject.get('name'),
      totalSold: productObject.get('total_sold'),
      unitsReturned,
      unitsReturnedP: productObject.get('total_sold') !== 0 ? (unitsReturned * 100) / productObject.get('total_sold') : 0,
      unitsRepaired,
      unitsRepairedP: productObject.get('total_sold') !== 0 ? (unitsRepaired * 100) / productObject.get('total_sold') : 0,
      totalReveneu: productObject.get('price') * productObject.get('total_sold')
    };
  }

  async getDesignerStats() {
    let designers = await DesignersModel.getDesigners({limit: 1000}).find().then(designers => designers.map(designer => designer.toJSON()));
    let productsAndDesigners = await ProductsModel.getProductsByFilters({limit: 10000, includes: ['designer']}).find().then(products => products.map(function(product) {
      product = product.toJSON();
      return {
        productId : product.productId,
        designer : product.designer,
        returned: product.totalReturned ? product.totalReturned : 0,
        repaired : product.totalRepaired ? product.totalRepaired : 0
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
      let countingReturn = 0;
      let countingRepair = 0;
      productsFromDesigner.map (function (product) {
        countingReturn += product.returned;
        countingRepair += product.repaired;
        return product;
      })
      

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
  
  async getProductStatsByDesigner(designerId, date_from, date_to) {
    //get the designer and their products
    let designer = await DesignersModel.getDesigners({equal:[{key:'designerId', value: designerId}]});
   
    let productsFromDesigner = await ProductsModel.getProductsByFilters({limit: 10000, includes: ['designer']}).find().then(products => products.map(function(product) {
      return product.toJSON()
    }));
    
    let allTime = !date_from && !date_to ? true : false;
    date_from = date_from ? moment(date_from).toDate() : moment('20000101').toDate();
    date_to = date_to ? moment(date_to).toDate() : moment('21000101').toDate();
    
    var lastDay = function(y,m) {
      return  new Date(y, m +1, 0).getDate();
    }
    
    let fullMonth = date_from.getMonth() == date_to.getMonth() &&  date_from.getDate()==1 && lastDay(date_to.getFullYear(), date_to.getMonth()) == date_to.getDate() ? true : false;
    
    
    //filter by designer
    productsFromDesigner = productsFromDesigner.filter(function (product){    
      if (product.designer && product.designer.designerId == designerId) {
        return true;
      }
      return false;
    })
    
    let vendorOrders = await DesignersModel.getVendorOrdersByFilters({includes: ['vendorOrderVariants', 'vendorOrderVariants.variant'],
    limit: 10000, greaterOrEqual: [ { key: 'createdAt', value: date_from } ], lessOrEqual: [ { key: 'createdAt', value: date_to } ]}).find().then(vendorOrders => vendorOrders.map(vendorOrder => vendorOrder.toJSON()));
    
    let result = [];
     
    for (let i=0; i<productsFromDesigner.length; i++) {
      let product = productsFromDesigner[i];
      
      //get the orders from this product between dates
      let orders = await OrdersModel.getOrderProductsByFilters({limit:100000,greaterOrEqual: [ { key: 'createdAt', value: date_from } ], lessOrEqual: [ { key: 'createdAt', value: date_to } ],equal: [{key: 'product_id', value: product.productId}]}).find().then(ordersFromDesigner => ordersFromDesigner.map(order => order.toJSON()));
    
      let checkedIn = 0;
      vendorOrders = vendorOrders.map(function(vendorOrder){
        vendorOrder.vendorOrderVariants.map(function(variant){
          if (variant.variant.productId == product.productId) {
            checkedIn += variant.units;
          }
          return variant;
        })
        return vendorOrder;
      })
      
      let onHand = product.inventoryOnHand;
      if (!allTime) onHand = "N/A" //To Do: calculate it if the month is exact
      let shipped = 0;
      let orderedAllTime = 0;
    
      
      orders.map(function (order){
        if (order.quantity_shipped) {
          shipped += order.quantity_shipped;
        }
        return order;
      })
      
      if (fullMonth) {
        let month = date_from.getMonth()+1;
        let year = date_from.getFullYear();
        let productStock = await ProductsModel.getProductStockMonthly({includes:['product'], equal: [ { key: 'month', value: month }, { key: 'year', value: year }, {key: 'productId', value: product.productId}]}).find().then(productStockList => productStockList.map(stock => stock.toJSON()));  
        if (productStock.length > 0) {
          onHand = productStock[0].onHand;
        }
      }
      
      if (onHand !== "N/A") {
        var discrepancy = (checkedIn - (onHand + shipped)) > 0 ? (checkedIn - (onHand + shipped)) : (checkedIn - (onHand + shipped)) * -1;
      } else {
        var discrepancy = "N/A"
      }
      
      let ordersAllTime = await OrdersModel.getOrderProductsByFilters({limit:100000, equal: [{key: 'product_id', value: product.productId}]}).find().then(ordersFromDesigner => ordersFromDesigner.map(order => order.toJSON()));
      
      ordersAllTime.map(function (order){
        if (order.quantity) {
          orderedAllTime += order.quantity;
        }
        return order;
      })
      
      result.push({
        productId: product.productId,
        productName: product.name,
        discrepancy : discrepancy,
        onHand : onHand,
        shipped: shipped,
        checkedIn : checkedIn,
        orderedAllTime: orderedAllTime
      })
    }
    
    return result;
  }

}
