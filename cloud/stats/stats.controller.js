const { ProductsModel } = require('../products/products.model');
const { ReturnsModel } = require('../returns/returns.model');
const { OrdersModel } = require('../orders/orders.model');
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

}